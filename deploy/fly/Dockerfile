# syntax=docker/dockerfile:1.7
#
# OpenClaw gateway + @alter-ai/openclaw-plugin, packaged for Fly.io.
#
# Build context MUST be the openclaw-alter-plugin/ directory so src/
# and the plugin manifest are reachable. The fly.toml in this directory
# pins `build.dockerfile = "deploy/fly/Dockerfile"` and runs the build
# from the plugin root.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /build

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Lock + manifest first so dep install caches well.
COPY package.json pnpm-lock.yaml ./

# Plugin sources + build config.
COPY tsconfig.json ./
COPY src/ ./src/
COPY openclaw.plugin.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm run build

# Drop dev deps so we copy a lean node_modules into the runtime stage.
RUN pnpm prune --prod

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Tools the entrypoint + ssh sessions need.
# python3 + make + g++ are required because @openclaw/slack is fetched
# at boot via `openclaw plugins install`, and its native WebSocket deps
# (bufferutil / utf-8-validate) build via node-gyp on first install.
# Without python3 the slack install aborts and the entrypoint FATALs
# before the gateway can bind to :3000.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini curl \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Install the OpenClaw gateway globally. @openclaw/slack is released in
# lockstep with it, and the entrypoint installs the Slack plugin at exactly
# this version, so bumping this pin moves both.
#
# Version floor: the entrypoint's `openclaw models auth paste-api-key`
# step (installs the OpenAI credential) needs that subcommand, which was
# added in 2026.6.x and is ABSENT in 2026.5.x. Downgrading below that line
# makes the auth step fail closed (unknown subcommand -> exit 1 ->
# crash-loop), never a silent credential-less boot. Keep the pin >= 2026.6.11.
RUN npm install -g openclaw@2026.6.11

# Lay out the plugin package the way `openclaw plugins install /path`
# expects: a self-contained directory with package.json, dist/, the
# manifest, the skill markdown, and the runtime node_modules pruned
# down to production deps.
WORKDIR /app/plugin
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/openclaw.plugin.json ./openclaw.plugin.json
COPY --from=builder /build/src/skills ./src/skills
COPY --from=builder /build/node_modules ./node_modules

# Build stamps the entrypoint reads to skip work on a plain restart.
# Reinstalling both plugins on every boot is the most CPU-heavy thing the
# container does, and on a shared-CPU Fly machine a few restarts in a row
# spend the whole burst budget: the machine is then throttled to its
# baseline and a 1-minute boot can take 7.
#   plugin-build-id   changes whenever this image's plugin files change
#   openclaw-version  the gateway version; @openclaw/slack is pinned to it
RUN find . -type f | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum | cut -c1-64 > /app/plugin-build-id \
 && node -p "require('$(npm root -g)/openclaw/package.json').version" > /app/openclaw-version \
 && test -s /app/plugin-build-id && test -s /app/openclaw-version

# Gateway config template + entrypoint.
WORKDIR /app
COPY deploy/fly/openclaw.json.template /app/openclaw.json.template
COPY deploy/fly/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# State directory is mounted from a Fly volume in production. Pre-create
# so the entrypoint can write before the mount lands on a fresh deploy.
RUN mkdir -p /data
ENV OPENCLAW_STATE_DIR=/data
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=1536

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
