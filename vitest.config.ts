import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

const testSecret = "test-session-secret-with-at-least-thirty-two-characters";
process.env["SESSION_SECRET"] ??= testSecret;

const tokenPayload = base64Url(
  JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "worker@example.test",
    name: "Cloudflare User",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_plan_type: "pro",
    },
  }),
);
const idToken = `e30.${tokenPayload}.signature`;
let refreshTokenUses = 0;

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "https://app.example.test",
          COOKIE_SAME_SITE: "None",
          MAX_REQUEST_BYTES: 1024,
          SESSION_SECRET: testSecret,
        },
        async outboundService(request: Request): Promise<Response> {
          const url = new URL(request.url);
          if (url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/deviceauth/usercode") {
            return Response.json({
              device_auth_id: "device-1",
              user_code: "ABCD-1234",
              interval: "5",
            });
          }
          if (url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/deviceauth/token") {
            return Response.json({
              authorization_code: "authorization-code-1",
              code_challenge: "challenge-1",
              code_verifier: "verifier-1",
            });
          }
          if (url.origin === "https://auth.openai.com" && url.pathname === "/oauth/token") {
            const isRefresh = request.headers.get("content-type")?.includes("application/json") ?? false;
            if (isRefresh) {
              refreshTokenUses += 1;
              if (refreshTokenUses > 1) {
                return Response.json({ error: "invalid_grant" }, { status: 400 });
              }
            }
            return Response.json({
              access_token: idToken,
              refresh_token: isRefresh ? "refresh-token-2" : "refresh-token-1",
              id_token: idToken,
              expires_in: isRefresh ? 3600 : 0,
            });
          }
          if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/models") {
            return Response.json({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4" }] });
          }
          if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
            const body = await request.json<Record<string, unknown>>();
            if (
              body["store"] !== false ||
              body["model"] !== "gpt-5.5" ||
              "user" in body ||
              "safety_identifier" in body ||
              request.headers.has("x-real-ip") ||
              request.headers.get("originator") !== "login-with-chatgpt-for-cloudflare" ||
              request.headers.get("user-agent") !== "login-with-chatgpt-for-cloudflare/0.3.0"
            ) {
              return Response.json({ error: "request_not_normalized" }, { status: 400 });
            }
            return new Response('data: {"type":"response.output_text.delta","delta":"hi"}\n\n', {
              headers: { "content-type": "text/event-stream" },
            });
          }
          return Response.json({ error: "unexpected_test_request", url: request.url }, { status: 502 });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.vitest.ts"],
  },
});

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
