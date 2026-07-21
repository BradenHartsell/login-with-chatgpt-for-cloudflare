import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifySessionId } from "../src/crypto.ts";

describe("Cloudflare login proxy", () => {
  it("returns an unauthenticated session without allocating a cookie", async () => {
    const response = await SELF.fetch("https://login.example.test/api/chatgpt/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "unauthenticated" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("creates a durable pending session and routes its signed cookie back to the same object", async () => {
    const login = await SELF.fetch("https://login.example.test/api/chatgpt/login", {
      method: "POST",
      headers: { origin: "https://login.example.test" },
    });

    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({
      status: "pending",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("lwc_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");

    const session = await SELF.fetch("https://login.example.test/api/chatgpt/session", {
      headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({ status: "pending" });
  });

  it("rejects a browser origin that is not explicitly trusted", async () => {
    const response = await SELF.fetch("https://login.example.test/api/chatgpt/login", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "origin_not_allowed" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("supports credentialed CORS only for an explicitly trusted browser origin", async () => {
    const preflight = await SELF.fetch("https://login.example.test/api/chatgpt/login", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example.test",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const login = await SELF.fetch("https://login.example.test/api/chatgpt/login", {
      method: "POST",
      headers: { origin: "https://app.example.test" },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(login.headers.get("set-cookie")).toContain("SameSite=None");
  });

  it("treats a tampered cookie as unauthenticated", async () => {
    const response = await SELF.fetch("https://login.example.test/api/chatgpt/session", {
      headers: { cookie: "lwc_session=attacker-controlled.invalid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "unauthenticated" });
  });

  it("completes device auth, encrypts tokens, streams responses, and deletes the session on logout", async () => {
    const login = await SELF.fetch("https://login.example.test/api/chatgpt/login", {
      method: "POST",
      headers: { origin: "https://login.example.test" },
    });
    const setCookie = login.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0] ?? "";
    const signedSessionId = cookie.slice(cookie.indexOf("=") + 1);
    const sessionId = await verifySessionId(
      decodeURIComponent(signedSessionId),
      "test-session-secret-with-at-least-thirty-two-characters",
    );
    expect(sessionId).toBeTypeOf("string");

    const status = await SELF.fetch("https://login.example.test/api/chatgpt/status", {
      headers: { cookie },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: "authenticated",
      user: { accountId: "account-1", email: "worker@example.test", plan: "pro" },
    });

    const object = env.CHATGPT_SESSIONS.getByName(sessionId ?? "missing");
    const storedCiphertext = await runInDurableObject(object, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ tokens_cipher: string | null }>("SELECT tokens_cipher FROM session_state WHERE singleton = 1")
        .one();
      return row.tokens_cipher;
    });
    expect(storedCiphertext).toBeTypeOf("string");
    expect(storedCiphertext).not.toContain("refresh-token-1");

    const [modelsA, modelsB] = await Promise.all([
      SELF.fetch("https://login.example.test/api/chatgpt/models", { headers: { cookie } }),
      SELF.fetch("https://login.example.test/api/chatgpt/models", { headers: { cookie } }),
    ]);
    expect(modelsA.status).toBe(200);
    expect(modelsB.status).toBe(200);
    await expect(modelsA.json()).resolves.toEqual({ models: ["gpt-5.5", "gpt-5.4"] });
    await expect(modelsB.json()).resolves.toEqual({ models: ["gpt-5.5", "gpt-5.4"] });

    const oversized = await SELF.fetch("https://login.example.test/api/chatgpt/responses", {
      method: "POST",
      headers: { cookie, origin: "https://login.example.test", "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(1100) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "responses_request_too_large" });

    const responses = await SELF.fetch("https://login.example.test/api/chatgpt/responses", {
      method: "POST",
      headers: { cookie, origin: "https://login.example.test", "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(responses.status).toBe(200);
    expect(responses.headers.get("content-type")).toBe("text/event-stream");
    await expect(responses.text()).resolves.toContain('"delta":"hi"');

    const logout = await SELF.fetch("https://login.example.test/api/chatgpt/logout", {
      method: "POST",
      headers: { cookie, origin: "https://login.example.test" },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const afterLogout = await SELF.fetch("https://login.example.test/api/chatgpt/session", { headers: { cookie } });
    await expect(afterLogout.json()).resolves.toEqual({ status: "unauthenticated" });
  });
});
