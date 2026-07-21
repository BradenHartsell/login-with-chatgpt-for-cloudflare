# Contributing

Thanks for improving the Cloudflare implementation.

## Scope

This repository accepts Cloudflare-specific changes. Cross-runtime server adapters, React components, AI SDK packages, Bun applications, Docker support, and the upstream documentation site belong in [opencoredev/login-with-chatgpt](https://github.com/opencoredev/login-with-chatgpt).

## Development

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and replace the example secret.
4. Make a focused change with Workers-runtime tests.
5. Run `npm run check` before opening a pull request.

## Required boundaries

- Keep one signed session id mapped to one SQLite Durable Object.
- Keep OAuth credentials inside the Durable Object.
- Do not add a token-export route or log bearer material.
- Keep token refresh serialized across every route.
- Keep streamed Responses bodies unbuffered after upstream headers arrive.
- Do not replace strongly consistent session state with Workers KV.
- Validate all cookie, network, storage, and request data at its boundary.
- Regenerate `worker-configuration.d.ts` after changing Worker bindings.

## Pull requests

Explain what changed, why it belongs in the Cloudflare fork, and which unhappy paths are covered. Do not include real credentials, production data, generated local state, or unrelated formatting changes.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
