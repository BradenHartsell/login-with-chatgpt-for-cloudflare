# Unofficial Cloudflare Worker adapter for login-with-chatgpt

A Cloudflare-only login proxy for applications that let users connect their own ChatGPT account. It runs as one Worker with one SQLite Durable Object per login session. OAuth credentials stay inside the Durable Object and never cross the public API boundary.

> [!IMPORTANT]
> This is an independent, community-maintained Cloudflare fork of [opencoredev/login-with-chatgpt](https://github.com/opencoredev/login-with-chatgpt). It is not created, supported, certified, or endorsed by OpenAI or Cloudflare. For the cross-runtime SDK, React components, AI SDK adapters, Bun server, documentation site, and Docker support, use the [original project](https://github.com/opencoredev/login-with-chatgpt).

This repository was derived from upstream commit [`7b3deeb`](https://github.com/opencoredev/login-with-chatgpt/commit/7b3deeb6e6bd539d594947f258a2fc26cf8fe866) and rewritten as a focused Cloudflare Worker. The upstream copyright and MIT license are preserved in [LICENSE](./LICENSE), with provenance recorded in [NOTICE.md](./NOTICE.md).

## Architecture

```text
Client
  -> Cloudflare Worker
       -> validates route, method, origin, and signed session cookie
       -> routes by opaque session id
       -> ChatGPTSession Durable Object
            -> encrypted OAuth credentials in private SQLite storage
            -> serialized refresh and proxy setup
            -> OpenAI device authorization and token endpoints
            -> streamed ChatGPT Codex responses
```

The Worker owns the public HTTP and cookie boundary. A `ChatGPTSession` Durable Object owns all state and mutations for exactly one ChatGPT login. Its SQLite database is the canonical session store. No KV namespace, external database, container, or generic application server is required.

## Routes

All auth routes use `BASE_PATH`, which defaults to `/api/chatgpt`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/chatgpt/login` | Start or reuse a device-code login and issue a signed session cookie |
| `GET` | `/api/chatgpt/status` | Poll the device flow and refresh an authenticated session when needed |
| `GET` | `/api/chatgpt/session` | Read the current public session without contacting OpenAI |
| `POST` | `/api/chatgpt/logout` | Delete the Durable Object session state and clear the cookie |
| `GET` | `/api/chatgpt/models` | List models available to the connected ChatGPT account |
| `POST` | `/api/chatgpt/responses` | Proxy a Responses request and stream the upstream response |
| `GET` | `/health` | Worker health check |

## Local setup

Requirements:

- Node.js 24 or newer
- A Cloudflare account for deployment

Install dependencies:

```sh
npm install
```

Create a local secret:

```sh
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url'))" > .dev.vars
```

Start the local Worker:

```sh
npm run dev
```

Run the complete local validation:

```sh
npm run check
```

## Deploy

Generate a secret value locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Store that value as the Worker secret, then deploy:

```sh
npx wrangler secret put SESSION_SECRET
npm run deploy
```

The `secrets.required` declaration makes deployment fail closed when `SESSION_SECRET` is missing. The Worker also rejects secrets shorter than 32 characters. Do not place its value in `wrangler.jsonc`.

## Client flow

1. Call `POST /api/chatgpt/login` and retain the `Set-Cookie` value.
2. Show `verificationUrl` and `userCode` to the user.
3. Poll `GET /api/chatgpt/status` no faster than the returned `interval`.
4. After the status becomes `authenticated`, use `/models` and `/responses` with the same cookie.
5. Call `POST /api/chatgpt/logout` when the user disconnects the account.

Native clients must use a cookie jar or preserve the `lwc_session` cookie explicitly. A VXBE account session and this ChatGPT connection session are separate security boundaries. VXBE should authenticate its own user first, then expose these routes only through the account and profile owner that is allowed to use the connection.

## Configuration

Non-secret settings live in `wrangler.jsonc`:

- `BASE_PATH`: public route prefix
- `COOKIE_NAME`: signed session cookie name
- `COOKIE_SAME_SITE`: `Lax` by default, or `None` for an HTTPS cross-origin browser client
- `DEFAULT_MODEL`: model used when a Responses body omits `model`
- `OPENAI_ORIGINATOR`: honest harness identity sent to the Codex service
- `OPENAI_USER_AGENT`: matching user-agent identity and adapter version
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed for non-GET requests
- `SESSION_TTL_SECONDS`: authenticated session lifetime
- `MAX_REQUEST_BYTES`: bounded JSON body size for the Responses proxy
- `RESPONSES_RATE_LIMIT`: per-session request count
- `RESPONSES_RATE_WINDOW_SECONDS`: fixed rate window

The default body limit is 16 MiB because Workers have a fixed isolate memory ceiling and JSON plus base64 inputs require multiple in-memory representations. Larger media workflows should stage assets in object storage and send references instead of raising this value without memory testing.

## Security properties

- Session ids are random and signed with a domain-separated HMAC key.
- OAuth tokens are encrypted with AES-GCM using a separate derived key and Durable Object identity as authenticated context.
- The public API never exports access or refresh tokens.
- A valid signed cookie maps to exactly one Durable Object.
- Each Durable Object serializes stateful request setup, preventing concurrent use of the same rotating refresh token.
- Rate counters and session state are strongly consistent inside the same SQLite Durable Object.
- Browser writes are same-origin by default and fail with `403` for untrusted origins.
- Responses are streamed from the Durable Object through the outer Worker without buffering the upstream event stream.
- The public Codex OAuth client id is used only for the OAuth client identity. The adapter identifies its actual harness separately through `originator` and `User-Agent`; do not claim `codex_cli_rs` unless the caller really is the Codex CLI.
- Client-supplied `user` and `safety_identifier` fields are removed. The connected ChatGPT account remains the upstream subscription and allowance boundary, while deployers must keep their own application account and profile boundary server-side.
- Client IP addresses are neither stored nor forwarded. There is no documented Codex subscription contract for an application to spoof an end-user network address, and Cloudflare egress rotation is not an identity or quota boundary.

The package also exports `./openai`, `./session`, and `./crypto` for server-side Cloudflare integrations that need the provider transport without the cookie-facing HTTP adapter. Keep those imports on trusted Workers only. Never bundle them into a client application.

See [SECURITY.md](./SECURITY.md) for private vulnerability reporting and deployment-specific security responsibilities.

## Compatibility and responsibility

The OAuth and Codex request shapes in this project follow the public behavior used by OpenAI's Codex clients and the original project. They are separate from the standard OpenAI API and may change independently. Operators are responsible for monitoring upstream behavior, protecting their Cloudflare account, and complying with the current [OpenAI terms and policies](https://openai.com/policies/) and [Cloudflare terms](https://www.cloudflare.com/terms/).

Do not describe a deployment as an official OpenAI or Cloudflare integration. OpenAI, ChatGPT, and related marks belong to OpenAI. Review the current [OpenAI brand guidelines](https://openai.com/brand/) before naming or marketing a product built with this project.

## Validation

```sh
npm run types
npm run typecheck
npm test
npm run deploy:dry-run
```

The Worker tests run in Cloudflare's Workers Vitest pool and cover durable cookie routing, origin rejection, tampered cookies, device authorization, encrypted credential storage, concurrent refresh serialization, model discovery, bounded bodies, streamed responses, and logout cleanup.

## Contributing and support

Cloudflare-specific bug reports and contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or pull request. Bugs in the cross-runtime SDK or its React and AI SDK packages should be reported to the [upstream repository](https://github.com/opencoredev/login-with-chatgpt/issues).

This project is provided without a hosted service or support guarantee. Deployers own their Worker, Durable Object data, secrets, costs, user disclosures, and incident response.

## License

MIT. The original copyright notice remains in [LICENSE](./LICENSE). Cloudflare-specific provenance and acknowledgements are in [NOTICE.md](./NOTICE.md).
