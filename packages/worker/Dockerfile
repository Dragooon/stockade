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

# Install openssh-client, curl, and ca-certificates for proxy
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy monorepo root files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/worker/package.json packages/worker/package.json

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/packages/worker/dist packages/worker/dist

WORKDIR /app/packages/worker

# Create directories for SSH cert injection, Claude Code credentials, and workspace
RUN mkdir -p /home/node/.ssh /home/node/.claude /workspace \
    && chown -R node:node /home/node/.ssh /home/node/.claude /workspace

# Install apw CLI (credential proxy ref token tool)
COPY packages/proxy/src/cli/apw /usr/local/bin/apw
RUN chmod +x /usr/local/bin/apw

# Run as non-root
USER node

ENV PORT=3001
EXPOSE 3001
CMD ["/bin/sh", "/app/entrypoint.sh"]
