const AUTH_CLAIM = "https://api.openai.com/auth";
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const REASONING_ENCRYPTED_CONTENT = "reasoning.encrypted_content";

export const DEFAULT_MODEL = "gpt-5.5";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_CLIENT_VERSION = "0.142.5";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_INSTRUCTIONS =
  "You are a helpful assistant powered by the user's ChatGPT account. Answer the user's request directly and helpfully.";

export type LoginStatus = "unauthenticated" | "pending" | "authenticated" | "expired" | "error";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ServiceTier = "auto" | "default" | "flex" | "priority" | "fast";

export interface ChatGPTTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface ChatGPTUser {
  accountId: string;
  email?: string;
  name?: string;
  plan?: string;
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
}

export type DevicePollResult =
  | { status: "pending" }
  | {
      status: "authorized";
      authorizationCode: string;
      codeChallenge: string;
      codeVerifier: string;
    };

export interface OpenAIConfig {
  clientId: string;
  clientVersion: string;
  codexBaseUrl: string;
  originator: string;
  scope: string;
  tokenUrl: string;
  deviceApiBase: string;
  deviceVerificationUrl: string;
  deviceRedirectUri: string;
}

export interface ResponsesOptions {
  instructions?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: string;
  textVerbosity?: "low" | "medium" | "high";
  serviceTier?: ServiceTier;
}

export class ChatGPTAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly body?: string;

  constructor(code: string, message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGPTAuthError";
    this.code = code;
    this.status = options.status;
    this.body = options.body;
  }
}

export function resolveOpenAIConfig(): OpenAIConfig {
  return {
    clientId: DEFAULT_CLIENT_ID,
    clientVersion: DEFAULT_CLIENT_VERSION,
    codexBaseUrl: DEFAULT_CODEX_BASE_URL,
    originator: DEFAULT_ORIGINATOR,
    scope: DEFAULT_SCOPE,
    tokenUrl: `${DEFAULT_ISSUER}/oauth/token`,
    deviceApiBase: `${DEFAULT_ISSUER}/api/accounts`,
    deviceVerificationUrl: `${DEFAULT_ISSUER}/codex/device`,
    deviceRedirectUri: `${DEFAULT_ISSUER}/deviceauth/callback`,
  };
}

export async function requestDeviceCode(
  config: OpenAIConfig,
  now: () => number = Date.now,
): Promise<DeviceCode> {
  let response: Response;
  try {
    response = await fetch(`${config.deviceApiBase}/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: config.clientId }),
    });
  } catch (cause) {
    throw new ChatGPTAuthError("network_error", "Failed to reach the device authorization endpoint.", { cause });
  }

  if (response.status === 404) {
    throw new ChatGPTAuthError("device_code_disabled", "Device-code login is not enabled for this OAuth client.", {
      status: 404,
    });
  }
  if (!response.ok) {
    throw new ChatGPTAuthError("device_code_request_failed", `Device code request failed (${response.status}).`, {
      status: response.status,
      body: await safeText(response),
    });
  }

  const raw = await response.json<{
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  }>();
  const userCode = raw.user_code ?? raw.usercode;
  if (!raw.device_auth_id || !userCode) {
    throw new ChatGPTAuthError("device_code_request_failed", "Device code response was missing required fields.");
  }
  return {
    deviceAuthId: raw.device_auth_id,
    userCode,
    verificationUrl: config.deviceVerificationUrl,
    interval: normalizeInterval(raw.interval),
    expiresAt: now() + DEVICE_CODE_TTL_MS,
  };
}

export async function pollDeviceCode(
  config: OpenAIConfig,
  device: Pick<DeviceCode, "deviceAuthId" | "userCode">,
): Promise<DevicePollResult> {
  let response: Response;
  try {
    response = await fetch(`${config.deviceApiBase}/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    });
  } catch (cause) {
    throw new ChatGPTAuthError("network_error", "Failed to reach the device token endpoint.", { cause });
  }

  if (response.status === 403 || response.status === 404 || response.status === 429) {
    return { status: "pending" };
  }
  if (!response.ok) {
    throw new ChatGPTAuthError("token_exchange_failed", `Device authorization failed (${response.status}).`, {
      status: response.status,
      body: await safeText(response),
    });
  }

  const raw = await response.json<{
    authorization_code?: string;
    code_challenge?: string;
    code_verifier?: string;
  }>();
  if (!raw.authorization_code || !raw.code_challenge || !raw.code_verifier) {
    return { status: "pending" };
  }
  return {
    status: "authorized",
    authorizationCode: raw.authorization_code,
    codeChallenge: raw.code_challenge,
    codeVerifier: raw.code_verifier,
  };
}

export function exchangeDeviceAuthorization(
  config: OpenAIConfig,
  poll: Extract<DevicePollResult, { status: "authorized" }>,
): Promise<ChatGPTTokens> {
  return exchangeAuthorizationCode(config, {
    code: poll.authorizationCode,
    codeVerifier: poll.codeVerifier,
    redirectUri: config.deviceRedirectUri,
  });
}

async function exchangeAuthorizationCode(
  config: OpenAIConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<ChatGPTTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
  } catch (cause) {
    throw new ChatGPTAuthError("network_error", "Failed to reach the token endpoint.", { cause });
  }
  if (!response.ok) {
    throw new ChatGPTAuthError("token_exchange_failed", `Authorization code exchange failed (${response.status}).`, {
      status: response.status,
      body: await safeText(response),
    });
  }
  return toTokens(await response.json<RawTokenResponse>());
}

const DEAD_REFRESH_ERRORS = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
]);

async function refreshTokens(config: OpenAIConfig, refreshToken: string): Promise<ChatGPTTokens> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        scope: config.scope,
      }),
    });
  } catch (cause) {
    throw new ChatGPTAuthError("network_error", "Failed to reach the token endpoint.", { cause });
  }
  if (!response.ok) {
    const body = await safeText(response);
    const code = extractErrorCode(body);
    if (code && DEAD_REFRESH_ERRORS.has(code)) {
      throw new ChatGPTAuthError("refresh_token_invalid", "The refresh token is no longer valid.", {
        status: response.status,
        body,
      });
    }
    throw new ChatGPTAuthError("token_refresh_failed", `Token refresh failed (${response.status}).`, {
      status: response.status,
      body,
    });
  }
  return toTokens(await response.json<RawTokenResponse>(), refreshToken);
}

export async function ensureFreshTokens(
  config: OpenAIConfig,
  tokens: ChatGPTTokens | undefined,
  now: () => number = Date.now,
): Promise<{ tokens: ChatGPTTokens; refreshed: boolean }> {
  if (tokens?.accessToken && !isAccessTokenExpired(tokens, now)) {
    return { tokens: withAccountId(tokens), refreshed: false };
  }
  if (!tokens?.refreshToken) {
    if (tokens?.accessToken) return { tokens: withAccountId(tokens), refreshed: false };
    throw new ChatGPTAuthError("not_authenticated", "The user must sign in.");
  }
  return { tokens: withAccountId(await refreshTokens(config, tokens.refreshToken)), refreshed: true };
}

export async function listCodexModels(config: OpenAIConfig, tokens: ChatGPTTokens): Promise<string[]> {
  const response = await codexRequest(config, tokens, "/models", { method: "GET", headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new ChatGPTAuthError("models_request_failed", `Model list request failed (${response.status}).`, {
      status: response.status,
      body: await safeText(response),
    });
  }
  return extractModelSlugs(await response.json<unknown>());
}

export function proxyCodexResponses(
  config: OpenAIConfig,
  tokens: ChatGPTTokens,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  return codexRequest(config, tokens, "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body,
    signal,
  });
}

async function codexRequest(
  config: OpenAIConfig,
  tokens: ChatGPTTokens,
  path: string,
  init: RequestInit,
): Promise<Response> {
  if (!tokens.accountId) throw new ChatGPTAuthError("invalid_token", "ChatGPT account id is missing.");
  const url = new URL(`${config.codexBaseUrl}${path}`);
  url.searchParams.set("client_version", config.clientVersion);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${tokens.accessToken}`);
  headers.set("chatgpt-account-id", tokens.accountId);
  headers.set("openai-beta", "responses=experimental");
  headers.set("originator", config.originator);
  return fetch(url, { ...init, headers });
}

export function normalizeResponsesBody(
  body: Record<string, unknown>,
  options: ResponsesOptions = {},
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...body };
  if (typeof output["instructions"] !== "string") {
    output["instructions"] = options.instructions ?? DEFAULT_INSTRUCTIONS;
  }
  output["store"] = false;
  output["reasoning"] = {
    effort: options.reasoningEffort ?? "medium",
    summary: options.reasoningSummary ?? "auto",
    ...(isRecord(output["reasoning"]) ? output["reasoning"] : {}),
  };
  output["text"] = {
    verbosity: options.textVerbosity ?? "medium",
    ...(isRecord(output["text"]) ? output["text"] : {}),
  };
  if (typeof output["service_tier"] !== "string" && options.serviceTier) {
    output["service_tier"] = options.serviceTier;
  }
  const include = new Set<string>(
    Array.isArray(output["include"])
      ? output["include"].filter((value): value is string => typeof value === "string")
      : [],
  );
  include.add(REASONING_ENCRYPTED_CONTENT);
  output["include"] = [...include];
  if (Array.isArray(output["input"])) output["input"] = filterCodexInput(output["input"]);
  delete output["max_output_tokens"];
  delete output["max_completion_tokens"];
  return output;
}

function filterCodexInput(input: unknown[]): unknown[] {
  return input
    .filter((item) => !(isRecord(item) && item["type"] === "item_reference"))
    .map((item) => {
      if (!isRecord(item) || !("id" in item)) return item;
      const { id: _id, ...rest } = item;
      return rest;
    });
}

function extractModelSlugs(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value["models"], value["data"], value["items"], value["available_models"]].find(Array.isArray) ?? []
      : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of candidates) {
    const candidate = typeof item === "string"
      ? item
      : isRecord(item)
        ? item["slug"] ?? item["id"] ?? item["model"] ?? item["name"]
        : undefined;
    if (typeof candidate !== "string") continue;
    const slug = candidate.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    output.push(slug);
  }
  return output;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function toTokens(raw: RawTokenResponse, previousRefreshToken?: string): ChatGPTTokens {
  if (!raw.access_token) {
    throw new ChatGPTAuthError("token_exchange_failed", "Token response missing access_token.");
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? previousRefreshToken,
    idToken: raw.id_token,
    accountId: deriveAccountId(raw.id_token) ?? deriveAccountId(raw.access_token),
    expiresAt: typeof raw.expires_in === "number" ? Date.now() + raw.expires_in * 1000 : getTokenExpiry(raw.access_token),
  };
}

function withAccountId(tokens: ChatGPTTokens): ChatGPTTokens {
  if (tokens.accountId) return tokens;
  const accountId = deriveAccountId(tokens.idToken) ?? deriveAccountId(tokens.accessToken);
  return accountId ? { ...tokens, accountId } : tokens;
}

function isAccessTokenExpired(tokens: ChatGPTTokens, now: () => number): boolean {
  const expiresAt = tokens.expiresAt ?? getTokenExpiry(tokens.accessToken);
  return typeof expiresAt === "number" && expiresAt <= now() + EXPIRY_MARGIN_MS;
}

export function parseUser(idToken: string | undefined): ChatGPTUser | undefined {
  const claims = decodeJwt(idToken);
  const accountId = deriveAccountId(idToken);
  if (!claims || !accountId) return undefined;
  const auth = isRecord(claims[AUTH_CLAIM]) ? claims[AUTH_CLAIM] : {};
  return {
    accountId,
    email: asString(claims["email"]),
    name: asString(claims["name"]),
    plan: asString(auth["chatgpt_plan_type"]),
  };
}

function deriveAccountId(token: string | undefined): string | undefined {
  const auth = decodeJwt(token)?.[AUTH_CLAIM];
  return isRecord(auth) && typeof auth["chatgpt_account_id"] === "string"
    ? auth["chatgpt_account_id"]
    : undefined;
}

function getTokenExpiry(token: string | undefined): number | undefined {
  const expiry = decodeJwt(token)?.["exp"];
  return typeof expiry === "number" ? expiry * 1000 : undefined;
}

function decodeJwt(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeInterval(value: string | number | undefined): number {
  const parsed = typeof value === "string" ? Number.parseInt(value.trim(), 10) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function extractErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && typeof parsed["error"] === "string" ? parsed["error"] : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
