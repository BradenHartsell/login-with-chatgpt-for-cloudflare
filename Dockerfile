# Deploys examples/demo. Built from the repo root so the demo's
# workspace:* dependencies (packages/*) resolve; Bun runs them from src
# via the "bun" export condition, so no package build step is needed.
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/react/package.json packages/react/
COPY packages/server/package.json packages/server/
COPY examples/demo/package.json examples/demo/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY examples/demo ./examples/demo

ENV NODE_ENV=production
EXPOSE 3000

WORKDIR /app/examples/demo
CMD ["bun", "run", "src/server.ts"]
