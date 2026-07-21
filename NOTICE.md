# Notices and provenance

## Original project

This repository is a Cloudflare-specific fork of:

- Project: [opencoredev/login-with-chatgpt](https://github.com/opencoredev/login-with-chatgpt)
- Source revision: [`7b3deeb6e6bd539d594947f258a2fc26cf8fe866`](https://github.com/opencoredev/login-with-chatgpt/commit/7b3deeb6e6bd539d594947f258a2fc26cf8fe866)
- Original copyright: Copyright (c) 2026 Leo
- Original license: MIT

The original copyright and license text are preserved in [LICENSE](./LICENSE).

## Cloudflare-specific work

The fork removes the upstream cross-runtime packages and rewrites the retained device authorization, OAuth token, session, and Codex proxy behavior as a Cloudflare Worker with SQLite Durable Objects.

The source history remains connected to the original GitHub fork network. Contributions to this repository are accepted under the same MIT license.

## Trademarks and independence

OpenAI, ChatGPT, Codex, and related marks are trademarks of OpenAI. Cloudflare and related marks are trademarks of Cloudflare. This independent open-source project is not affiliated with, endorsed by, or sponsored by OpenAI, Cloudflare, or the upstream maintainers.
