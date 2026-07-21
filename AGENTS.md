# Cloudflare-only repository instructions

This repository is the Cloudflare implementation. Do not restore generic Node, Bun server, React, AI SDK adapter, Docker, or documentation-site packages from upstream.

## Ownership

- `src/index.ts` is the Worker composition root and the `ChatGPTSession` Durable Object entrypoint.
- `src/session.ts` owns canonical SQLite session state, token refresh serialization, and per-session rate counters.
- `src/openai.ts` owns the OpenAI device authorization, OAuth token, model, and Codex Responses wire contracts.
- `src/crypto.ts` owns cookie signing and credential encryption.
- `src/cookies.ts` owns HTTP cookie parsing and serialization.

## Boundaries

- One signed session id maps to one SQLite Durable Object.
- OAuth credentials never leave the Durable Object or appear in public responses or logs.
- Do not replace strongly consistent Durable Object state with Workers KV.
- Keep refresh operations serialized across status, model, and response routes.
- Keep the upstream event stream streaming through both Worker layers.
- Validate stored, network, cookie, and request data at their boundaries.
- Declare bindings in `wrangler.jsonc` and regenerate `worker-configuration.d.ts` with `npm run types`.

## Required validation

Run `npm run check` after every production change. Add or update Workers Vitest coverage for authentication, cookie integrity, origin policy, persistence, refresh concurrency, request bounds, streaming, and logout behavior when those paths change.
