---
name: setup
description: >-
  Set up Stockade from scratch. Handles prerequisites check, dependency
  installation, config generation, API key setup, Docker network creation,
  and first run. Use when: "setup stockade", "install stockade",
  "get started", "configure stockade", or first time opening the project.
---

# Stockade Setup

Run through these steps in order. Skip any that are already done.

## 1. Check Prerequisites

```bash
node --version   # Need 22+
pnpm --version   # Need pnpm
docker --version # Optional, for sandboxed agents
```

If Node.js < 22, install it. If pnpm is missing, run `corepack enable && corepack prepare pnpm@latest --activate`. Docker is only needed for sandboxed agents — skip if running local-only.

## 2. Install Dependencies

```bash
pnpm install
```

## 3. Generate Config Files

Copy example configs if they don't exist:

```bash
cp -n config/config.example.yaml config/config.yaml
cp -n config/proxy.example.yaml config/proxy.yaml
```

## 4. Set Up API Key

The Anthropic API key is needed for agents to work. Check these sources in order:

1. **Environment variable**: Check if `ANTHROPIC_API_KEY` is set
2. **Claude Code credentials**: Check `~/.claude/.credentials.json` for an existing OAuth token
3. **Ask the user**: If neither exists, ask for the API key

Create the secrets directory and write the key:

```bash
mkdir -p config/secrets
echo "<api-key>" > config/secrets/anthropic-api-key
```

If the user has Claude Code credentials but no API key, tell them: sandboxed agents need an API key in `config/secrets/anthropic-api-key`. Local agents can use Claude Code's OAuth credentials directly.

## 5. Docker Network (if using sandboxed agents)

If Docker is available and config has `sandboxed: true` agents:

```bash
docker network create --driver bridge --internal stockade-net 2>/dev/null || true
```

## 6. Build

```bash
pnpm build
```

## 7. Choose Run Mode

Ask the user which mode they want:

**Simple (no Docker)**: Edit `config/config.yaml` — set `sandboxed: false` on all agents. Then:

```bash
pnpm start:orchestrator
```

**Full stack (containers + proxy)**: Keep `sandboxed: true` (default). Start in two terminals:

```bash
# Terminal 1
pnpm start:proxy

# Terminal 2
pnpm start:orchestrator
```

## 8. Verify

```bash
pnpm test   # Should see 749 tests passing
```

## Summary

After setup, tell the user:
- Config files are in `config/` — edit `config.yaml` to add agents, change models, adjust permissions
- Secrets are in `config/secrets/` (gitignored, never committed)
- Docs at https://dragooon.github.io/stockade/
- `pnpm start:orchestrator` to start, type a message in terminal to test
