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
RUN pnpm --filter @stockade/worker build

# ── Production stage ──────────────────────────────────────────────
FROM node:22-slim

RUN corepack enable

# Install openssh-client, curl, and ca-certificates for proxy
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client curl ca-certificates python3 python3-pip git docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install tavily-cli for search capabilities
RUN pip3 install --break-system-packages tavily-cli

# Install agentmail-cli for programmatic email
RUN npm install -g agentmail-cli@0.7.11

# Install chrome-devtools-mcp baked-in (pinned) so the browser MCP server starts
# fast and deterministically. Previously launched via `npx -y chrome-devtools-mcp@latest`,
# which re-resolved @latest against the npm registry on every cold start (30–78s through
# the runtime proxy) and lost the SDK's MCP-init race → mcp__chrome__* tools never registered.
RUN npm install -g chrome-devtools-mcp@1.2.0

# Patch getElementByUid to tolerate the displayed "uid=" prefix. The snapshot renders
# elements as `uid=1_34`, but the internal lookup map is keyed by the bare id `1_34`, so
# passing the whole displayed token (which the model naturally copies) to click/fill/
# upload_file missed the map and threw "Element uid not found" — while snapshot/navigate/
# screenshot/evaluate (which never resolve a uid) kept working. Strip a leading `uid=` so
# both forms resolve. Idempotent; fails the build loudly if the source shape changes.
RUN node -e ' \
  const fs=require("fs"); \
  const f="/usr/local/lib/node_modules/chrome-devtools-mcp/build/src/McpPage.js"; \
  let s=fs.readFileSync(f,"utf8"); \
  if(s.includes("uid.slice(4)")){process.exit(0);} \
  const n="        const node = this.textSnapshot.idToNode.get(uid);"; \
  if(!s.includes(n)){console.error("uid-prefix patch: needle not found");process.exit(1);} \
  s=s.replace(n,"        if (typeof uid === \"string\" && uid.startsWith(\"uid=\")) uid = uid.slice(4);\n"+n); \
  fs.writeFileSync(f,s); \
  '

# Install gogcli (Google CLI: Gmail, Calendar, Drive, etc.) — linux amd64 binary
RUN curl -fsSL https://github.com/steipete/gogcli/releases/download/v0.14.0/gogcli_0.14.0_linux_amd64.tar.gz \
    | tar -xz -C /tmp \
    && mv /tmp/gog /usr/local/bin/gog \
    && chmod +x /usr/local/bin/gog \
    && rm -rf /tmp/LICENSE /tmp/README.md /tmp/CHANGELOG.md 2>/dev/null || true

WORKDIR /app

# Copy monorepo root files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/worker/package.json packages/worker/package.json

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/packages/worker/dist packages/worker/dist

# Copy entrypoint (strip Windows CRLF line endings)
COPY packages/worker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

WORKDIR /app/packages/worker

# Create directories for SSH cert injection, Claude Code credentials, and workspace
RUN mkdir -p /home/node/.ssh /home/node/.claude /workspace \
    && chown -R node:node /home/node/.ssh /home/node/.claude /workspace

# Install apw CLI (credential proxy ref token tool, strip Windows CRLF)
COPY packages/proxy/src/cli/apw /usr/local/bin/apw
RUN sed -i 's/\r$//' /usr/local/bin/apw && chmod +x /usr/local/bin/apw

# Run as non-root
USER node

ENV PORT=3001
EXPOSE 3001
CMD ["/bin/sh", "/app/entrypoint.sh"]
