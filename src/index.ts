import { DurableObject } from "cloudflare:workers";
import { type CookieSameSite, clearSessionCookie, readCookie, sessionCookie } from "./cookies.ts";
import { randomSessionId, signSessionId, verifySessionId } from "./crypto.ts";
import {
  type OpenAIConfig,
  type ReasoningEffort,
  type ServiceTier,
  ChatGPTAuthError,
  DEFAULT_MODEL,
  listCodexModels,
  normalizeResponsesBody,
  proxyCodexResponses,
  resolveOpenAIConfig,
} from "./openai.ts";
import { SessionService, SessionStore } from "./session.ts";

const METHODS = new Map([
  ["/login", "POST"],
  ["/status", "GET"],
  ["/session", "GET"],
  ["/logout", "POST"],
  ["/models", "GET"],
  ["/responses", "POST"],
]);
const SERVICE_TIERS = new Set<ServiceTier>(["auto", "default", "flex", "priority", "fast"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh"]);

export class ChatGPTSession extends DurableObject<Env> {
  private readonly sessions: SessionService;
  private readonly openAIConfig: OpenAIConfig;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sessionTtlMs = env.SESSION_TTL_SECONDS * 1000;
    const store = new SessionStore(ctx.storage, {
      secret: env.SESSION_SECRET,
      encryptionContext: `chatgpt-session:${ctx.id.toString()}`,
      sessionTtlMs,
    });
    this.openAIConfig = resolveOpenAIConfig({
      originator: env.OPENAI_ORIGINATOR,
      userAgent: env.OPENAI_USER_AGENT,
    });
    this.sessions = new SessionService(store, this.openAIConfig);
  }

  override fetch(request: Request): Promise<Response> {
    const response = this.requestTail.then(() => this.dispatch(request));
    this.requestTail = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  private async dispatch(request: Request): Promise<Response> {
    try {
      const route = subroute(new URL(request.url).pathname, this.env.BASE_PATH);
      switch (route) {
        case "/login": {
          const { device } = await this.sessions.startLogin();
          return json({
            status: "pending",
            userCode: device.userCode,
            verificationUrl: device.verificationUrl,
            interval: device.interval,
            expiresAt: device.expiresAt,
          });
        }
        case "/status": {
          const data = await this.sessions.advance();
          return json(data.user ? { status: data.status, user: data.user } : { status: data.status });
        }
        case "/session": {
          const data = await this.sessions.load();
          if (!data) return json({ status: "unauthenticated" });
          return json(data.user ? { status: data.status, user: data.user } : { status: data.status });
        }
        case "/logout":
          this.sessions.logout();
          return json({ status: "unauthenticated" });
        case "/models":
          return this.handleModels();
        case "/responses":
          return this.handleResponses(request);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      if (error instanceof ChatGPTAuthError) {
        return json(
          { error: error.code, message: error.message, status: error.status },
          { status: error.status ?? 502 },
        );
      }
      console.error(JSON.stringify({ event: "chatgpt_session_request_failed", error: errorMessage(error) }));
      return json({ error: "internal_error" }, { status: 500 });
    }
  }

  private async handleModels(): Promise<Response> {
    const tokens = await this.sessions.freshTokens();
    if (!tokens?.accessToken || !tokens.accountId) return json({ error: "not_authenticated" }, { status: 401 });
    const models = await listCodexModels(this.openAIConfig, tokens);
    return json({ models });
  }

  private async handleResponses(request: Request): Promise<Response> {
    const rate = this.sessions.consumeResponsesRateLimit(
      this.env.RESPONSES_RATE_LIMIT,
      this.env.RESPONSES_RATE_WINDOW_SECONDS * 1000,
    );
    if (!rate.allowed) {
      return json(
        { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds },
        { status: 429, headers: { "retry-after": String(rate.retryAfterSeconds ?? 1) } },
      );
    }
    const tokens = await this.sessions.freshTokens();
    if (!tokens?.accessToken || !tokens.accountId) return json({ error: "not_authenticated" }, { status: 401 });

    const serviceTier = readServiceTier(request);
    if (serviceTier instanceof Response) return serviceTier;
    const reasoningEffort = readReasoningEffort(request);
    if (reasoningEffort instanceof Response) return reasoningEffort;
    const payload = await prepareResponsesPayload(request, {
      defaultModel: this.env.DEFAULT_MODEL || DEFAULT_MODEL,
      maxRequestBytes: this.env.MAX_REQUEST_BYTES,
      serviceTier,
      reasoningEffort,
    });
    if (payload instanceof Response) return payload;

    let upstream = await proxyCodexResponses(this.openAIConfig, tokens, payload, request.signal);
    if (!upstream.ok) {
      let detail = await safeText(upstream);
      if (serviceTier === "fast" && detail.toLowerCase().includes("unsupported service_tier")) {
        upstream = await proxyCodexResponses(
          this.openAIConfig,
          tokens,
          removeJsonField(payload, "service_tier"),
          request.signal,
        );
        if (upstream.ok) {
          return streamResponse(upstream, { "x-login-with-chatgpt-service-tier-fallback": "auto" });
        }
        detail = await safeText(upstream);
      }
      console.error(JSON.stringify({ event: "codex_responses_failed", status: upstream.status }));
      return json(
        { error: "responses_request_failed", status: upstream.status, detail: detail.slice(0, 2000) },
        { status: upstream.status },
      );
    }
    return streamResponse(upstream);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      return json({ error: "worker_not_configured" }, { status: 500 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    const route = subroute(url.pathname, env.BASE_PATH);
    const allowedMethod = route ? METHODS.get(route) : undefined;
    if (!allowedMethod) return new Response("Not found", { status: 404 });
    const crossOrigin = trustedCrossOrigin(request, env.ALLOWED_ORIGINS);
    if (request.method === "OPTIONS") {
      return crossOrigin
        ? preflightResponse(crossOrigin, allowedMethod)
        : originNotAllowed(request.headers.get("origin") ?? "");
    }
    if (request.method !== allowedMethod) {
      return new Response("Method not allowed", { status: 405, headers: { allow: allowedMethod } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const blocked = checkOrigin(request, env.ALLOWED_ORIGINS);
      if (blocked) return blocked;
    }

    const signedCookie = readCookie(request, env.COOKIE_NAME);
    let sessionId = signedCookie ? await verifySessionId(signedCookie, env.SESSION_SECRET) : undefined;
    let issuedCookie: string | undefined;
    if (!sessionId && route === "/login") {
      sessionId = randomSessionId();
      issuedCookie = await signSessionId(sessionId, env.SESSION_SECRET);
    }

    if (!sessionId) return withCors(unauthenticatedResponse(route ?? "", request, env), crossOrigin);

    const stub = env.CHATGPT_SESSIONS.getByName(sessionId);
    const response = await stub.fetch(request);
    const headers = new Headers(response.headers);
    if (issuedCookie && response.ok) {
      headers.append(
        "set-cookie",
        sessionCookie(
          env.COOKIE_NAME,
          issuedCookie,
          env.SESSION_TTL_SECONDS,
          url.protocol === "https:",
          readSameSite(env.COOKIE_SAME_SITE),
        ),
      );
    }
    if (route === "/logout") {
      headers.append(
        "set-cookie",
        clearSessionCookie(env.COOKIE_NAME, url.protocol === "https:", readSameSite(env.COOKIE_SAME_SITE)),
      );
    }
    return withCors(
      new Response(response.body, { status: response.status, statusText: response.statusText, headers }),
      crossOrigin,
    );
  },
} satisfies ExportedHandler<Env>;

function unauthenticatedResponse(route: string, request: Request, env: Env): Response {
  if (route === "/status" || route === "/session") return json({ status: "unauthenticated" });
  if (route === "/logout") {
    return json(
      { status: "unauthenticated" },
      {
        headers: {
          "set-cookie": clearSessionCookie(
            env.COOKIE_NAME,
            new URL(request.url).protocol === "https:",
            readSameSite(env.COOKIE_SAME_SITE),
          ),
        },
      },
    );
  }
  return json({ error: "not_authenticated" }, { status: 401 });
}

function subroute(pathname: string, basePath: string): string | undefined {
  const normalized = basePath.startsWith("/") ? basePath.replace(/\/+$/, "") : `/${basePath.replace(/\/+$/, "")}`;
  if (pathname === normalized) return "/";
  return pathname.startsWith(`${normalized}/`) ? pathname.slice(normalized.length) : undefined;
}

function checkOrigin(request: Request, configuredOrigins: string): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return originNotAllowed(origin);
  }
  if (parsed.origin === new URL(request.url).origin) return undefined;
  const allowed = parseAllowedOrigins(configuredOrigins);
  return allowed.has(parsed.origin) ? undefined : originNotAllowed(parsed.origin);
}

function trustedCrossOrigin(request: Request, configuredOrigins: string): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }
  if (parsed.origin === new URL(request.url).origin) return undefined;
  const allowed = parseAllowedOrigins(configuredOrigins);
  return allowed.has(parsed.origin) ? parsed.origin : undefined;
}

function parseAllowedOrigins(configuredOrigins: string): Set<string> {
  const allowed = new Set<string>();
  for (const value of configuredOrigins.split(",")) {
    const candidate = value.trim();
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // Invalid configuration stays fail closed for that entry.
    }
  }
  return allowed;
}

function preflightResponse(origin: string, method: string): Response {
  return withCors(
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": method,
        "access-control-allow-headers":
          "content-type,x-login-with-chatgpt-service-tier,x-login-with-chatgpt-reasoning-effort",
        "access-control-max-age": "86400",
      },
    }),
    origin,
  );
}

function withCors(response: Response, origin: string | undefined): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function readSameSite(value: string): CookieSameSite {
  return value === "Strict" || value === "None" ? value : "Lax";
}

function originNotAllowed(origin: string): Response {
  return json({ error: "origin_not_allowed", origin }, { status: 403 });
}

async function prepareResponsesPayload(
  request: Request,
  options: {
    defaultModel: string;
    maxRequestBytes: number;
    serviceTier?: ServiceTier;
    reasoningEffort?: ReasoningEffort;
  },
): Promise<string | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > options.maxRequestBytes) {
    return json({ error: "responses_request_too_large", maxRequestBytes: options.maxRequestBytes }, { status: 413 });
  }
  const bytes = await readBoundedBody(request, options.maxRequestBytes);
  if (bytes instanceof Response) return bytes;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) {
      return json({ error: "invalid_responses_request", message: "Expected a JSON object body." }, { status: 400 });
    }
    parsed["model"] ??= options.defaultModel;
    if (typeof parsed["model"] !== "string" || parsed["model"].length === 0) {
      return json({ error: "invalid_responses_request", message: "model must be a string." }, { status: 400 });
    }
    return JSON.stringify(
      normalizeResponsesBody(parsed, {
        serviceTier: options.serviceTier,
        reasoningEffort: options.reasoningEffort,
      }),
    );
  } catch {
    return json({ error: "invalid_responses_request", message: "Expected a JSON object body." }, { status: 400 });
  }
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | Response> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return json({ error: "responses_request_too_large", maxRequestBytes: maximumBytes }, { status: 413 });
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function readServiceTier(request: Request): ServiceTier | Response | undefined {
  const raw = request.headers.get("x-login-with-chatgpt-service-tier");
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase() as ServiceTier;
  return SERVICE_TIERS.has(value) ? value : json({ error: "invalid_service_tier", serviceTier: raw }, { status: 400 });
}

function readReasoningEffort(request: Request): ReasoningEffort | Response | undefined {
  const raw = request.headers.get("x-login-with-chatgpt-reasoning-effort");
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase() as ReasoningEffort;
  return REASONING_EFFORTS.has(value)
    ? value
    : json({ error: "invalid_reasoning_effort", reasoningEffort: raw }, { status: 400 });
}

function streamResponse(upstream: Response, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function removeJsonField(body: string, field: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return body;
    delete parsed[field];
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function json(data: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
