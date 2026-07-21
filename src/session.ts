import { decryptJson, encryptJson } from "./crypto.js";
import {
  type ChatGPTTokens,
  type ChatGPTUser,
  type DeviceCode,
  type LoginStatus,
  type OpenAIConfig,
  ChatGPTAuthError,
  ensureFreshTokens,
  exchangeDeviceAuthorization,
  parseUser,
  pollDeviceCode,
  requestDeviceCode,
} from "./openai.js";

const PENDING_SESSION_TTL_MS = 30 * 60 * 1000;

export interface DeviceState {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
  lastPolledAt: number;
}

export interface SessionData {
  status: LoginStatus;
  device?: DeviceState | undefined;
  tokens?: ChatGPTTokens | undefined;
  user?: ChatGPTUser | undefined;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  [key: string]: SqlStorageValue;
  status: string;
  device_json: string | null;
  tokens_cipher: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export class SessionStore {
  private readonly sql: SqlStorage;
  private readonly secret: string;
  private readonly encryptionContext: string;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(
    storage: DurableObjectStorage,
    options: { secret: string; encryptionContext: string; sessionTtlMs: number; now?: () => number },
  ) {
    this.sql = storage.sql;
    this.secret = options.secret;
    this.encryptionContext = options.encryptionContext;
    this.sessionTtlMs = options.sessionTtlMs;
    this.now = options.now ?? Date.now;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        status TEXT NOT NULL,
        device_json TEXT,
        tokens_cipher TEXT,
        user_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    // Older releases stored decoded identity claims in plaintext. The encrypted
    // token envelope is sufficient to reconstruct the safe user projection.
    this.sql.exec("UPDATE session_state SET user_json = NULL WHERE user_json IS NOT NULL");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      )
    `);
  }

  async load(): Promise<SessionData | undefined> {
    const row = this.sql.exec<SessionRow>(
      "SELECT status, device_json, tokens_cipher, created_at, updated_at, expires_at FROM session_state WHERE singleton = 1",
    ).toArray()[0];
    if (!row) return undefined;
    if (row.expires_at <= this.now()) {
      this.delete();
      return undefined;
    }
    const status = parseStatus(row.status);
    const device = row.device_json ? parseDevice(row.device_json) : undefined;
    let tokens: ChatGPTTokens | undefined;
    if (row.tokens_cipher) {
      const decrypted = await decryptJson(this.secret, this.encryptionContext, row.tokens_cipher);
      tokens = parseTokens(decrypted);
      if (!tokens) throw new Error("Stored ChatGPT credentials could not be decrypted or validated.");
    }
    return {
      status,
      device,
      tokens,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async save(data: SessionData): Promise<void> {
    const updatedAt = this.now();
    const ttlMs = data.tokens ? this.sessionTtlMs : Math.min(this.sessionTtlMs, PENDING_SESSION_TTL_MS);
    const tokensCipher = data.tokens
      ? await encryptJson(data.tokens, this.secret, this.encryptionContext)
      : null;
    this.sql.exec(
      `INSERT INTO session_state (
        singleton, status, device_json, tokens_cipher, user_json, created_at, updated_at, expires_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        status = excluded.status,
        device_json = excluded.device_json,
        tokens_cipher = excluded.tokens_cipher,
        user_json = excluded.user_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at`,
      data.status,
      data.device ? JSON.stringify(data.device) : null,
      tokensCipher,
      null,
      data.createdAt,
      updatedAt,
      updatedAt + ttlMs,
    );
    data.updatedAt = updatedAt;
  }

  delete(): void {
    this.sql.exec("DELETE FROM session_state WHERE singleton = 1");
    this.sql.exec("DELETE FROM rate_limits");
  }

  consumeRateLimit(bucket: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds?: number } {
    const now = this.now();
    const row = this.sql.exec<{ count: number; reset_at: number }>(
      "SELECT count, reset_at FROM rate_limits WHERE bucket = ?",
      bucket,
    ).toArray()[0];
    if (!row || row.reset_at <= now) {
      this.sql.exec(
        "INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at",
        bucket,
        now + windowMs,
      );
      return { allowed: true };
    }
    if (row.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
    }
    this.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?", bucket);
    return { allowed: true };
  }
}

export class SessionService {
  private readonly store: SessionStore;
  private readonly config: OpenAIConfig;
  private readonly now: () => number;

  constructor(store: SessionStore, config: OpenAIConfig, now: () => number = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  async startLogin(): Promise<{ device: DeviceCode; data: SessionData }> {
    const existing = await this.store.load();
    if (existing?.device && existing.device.expiresAt > this.now()) {
      return { device: toDeviceCode(existing.device), data: existing };
    }
    const device = await requestDeviceCode(this.config, this.now);
    const data: SessionData = {
      status: "pending",
      device: { ...device, lastPolledAt: 0 },
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    await this.store.save(data);
    return { device, data };
  }

  async load(): Promise<SessionData | undefined> {
    const data = await this.store.load();
    if (data?.tokens) data.user = parseUser(data.tokens.idToken);
    return data;
  }

  async advance(): Promise<SessionData> {
    const data = await this.store.load();
    if (!data) return emptySession(this.now());
    if (data.tokens) {
      try {
        const result = await ensureFreshTokens(this.config, data.tokens, this.now);
        data.tokens = result.tokens;
        data.status = "authenticated";
        data.user ??= parseUser(result.tokens.idToken);
        await this.store.save(data);
        return data;
      } catch (error) {
        if (error instanceof ChatGPTAuthError && error.code === "refresh_token_invalid") {
          this.store.delete();
          return { ...emptySession(this.now()), status: "expired" };
        }
        throw error;
      }
    }
    if (!data.device) return data;
    if (this.now() >= data.device.expiresAt) {
      data.status = "expired";
      data.device = undefined;
      await this.store.save(data);
      return data;
    }
    if (this.now() - data.device.lastPolledAt < data.device.interval * 1000) return data;

    data.device.lastPolledAt = this.now();
    const result = await pollDeviceCode(this.config, data.device);
    if (result.status === "authorized") {
      const tokens = await exchangeDeviceAuthorization(this.config, result);
      data.tokens = tokens;
      data.user = parseUser(tokens.idToken);
      data.status = "authenticated";
      data.device = undefined;
    }
    await this.store.save(data);
    return data;
  }

  async freshTokens(): Promise<ChatGPTTokens | undefined> {
    const data = await this.store.load();
    if (!data?.tokens) return undefined;
    const result = await ensureFreshTokens(this.config, data.tokens, this.now);
    if (result.refreshed) {
      data.tokens = result.tokens;
      data.status = "authenticated";
      await this.store.save(data);
    }
    return result.tokens;
  }

  logout(): void {
    this.store.delete();
  }

  consumeResponsesRateLimit(limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds?: number } {
    return this.store.consumeRateLimit("responses", limit, windowMs);
  }
}

function emptySession(now: number): SessionData {
  return { status: "unauthenticated", createdAt: now, updatedAt: now };
}

function toDeviceCode(device: DeviceState): DeviceCode {
  return {
    deviceAuthId: device.deviceAuthId,
    userCode: device.userCode,
    verificationUrl: device.verificationUrl,
    interval: device.interval,
    expiresAt: device.expiresAt,
  };
}

function parseStatus(value: string): LoginStatus {
  if (["unauthenticated", "pending", "authenticated", "expired", "error"].includes(value)) {
    return value as LoginStatus;
  }
  throw new Error("Stored session has an invalid status.");
}

function parseDevice(value: string): DeviceState {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Stored device state is invalid.");
  const fields = ["deviceAuthId", "userCode", "verificationUrl"] as const;
  if (fields.some((field) => typeof parsed[field] !== "string")) {
    throw new Error("Stored device state is invalid.");
  }
  const numbers = ["interval", "expiresAt", "lastPolledAt"] as const;
  if (numbers.some((field) => typeof parsed[field] !== "number" || !Number.isFinite(parsed[field]))) {
    throw new Error("Stored device state is invalid.");
  }
  return parsed as unknown as DeviceState;
}

function parseTokens(value: unknown): ChatGPTTokens | undefined {
  if (!isRecord(value) || typeof value["accessToken"] !== "string") return undefined;
  for (const field of ["refreshToken", "idToken", "accountId"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return undefined;
  }
  if (value["expiresAt"] !== undefined && typeof value["expiresAt"] !== "number") return undefined;
  return value as unknown as ChatGPTTokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
