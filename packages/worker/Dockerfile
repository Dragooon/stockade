FROM node:22-slim AS builder

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy all monorepo files needed for install + build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/worker/ packages/worker/

# Install all deps (monorepo-aware)
RUN pnpm install --frozen-lockfile

# Build the worker
RUN pnpm --filter @agent-platform/worker build

# ── Production stage ──────────────────────────────────────────────
FROM node:22-slim

RUN corepack enable

# Install openssh-client, curl, and ca-certificates for proxy + gogcli
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install gogcli (Google services CLI) — Linux amd64
ARG GOGCLI_VERSION=0.12.0
RUN curl -fsSL "https://github.com/steipete/gogcli/releases/download/v${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /usr/local/bin gog \
    && chmod +x /usr/local/bin/gog

WORKDIR /app

# Copy monorepo root files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/worker/package.json packages/worker/package.json

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/packages/worker/dist packages/worker/dist

WORKDIR /app/packages/worker

# Create SSH directory for cert injection + gogcli config directory
RUN mkdir -p /home/node/.ssh /home/node/.config/gogcli \
    && chown -R node:node /home/node/.ssh /home/node/.config

# Copy entrypoint script (before switching to non-root user)
COPY packages/worker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Run as non-root
USER node

ENV PORT=3001
EXPOSE 3001
CMD ["/bin/sh", "/app/entrypoint.sh"]
