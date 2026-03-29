---
layout: default
title: Quick Start
---

# Quick Start

## One-Command Setup

```bash
git clone https://github.com/Dragooon/stockade.git
cd stockade
pnpm setup
```

This checks prerequisites, installs dependencies, copies config files, detects your API key, sets up Docker networking, and builds everything. Run `pnpm setup:no-docker` if you don't have Docker.

## Claude Code Setup

If you already have Claude Code installed, open the Stockade project and run `/setup`. The skill handles everything including detecting your existing Claude Code credentials for API access.

```bash
cd stockade
claude   # opens Claude Code in the project
# then type: /setup
```

## Prerequisites

- Node.js 22+
- pnpm
- Docker (for sandboxed agents — optional)
- An Anthropic API key

## Manual Setup

If you prefer to do it step by step:

### Install

```bash
git clone https://github.com/Dragooon/stockade.git
cd stockade
pnpm install
```

### Configure

```bash
cp config/config.example.yaml config/config.yaml
cp config/proxy.example.yaml config/proxy.yaml
```

Add your API key:

```bash
mkdir -p config/secrets
echo "sk-ant-..." > config/secrets/anthropic-api-key
```

> The `config/secrets/` directory is gitignored. Secrets never leave your machine.

### Build

```bash
pnpm build
```

## Run

### Simple mode (no containers)

Set `sandboxed: false` on your agents in config.yaml:

```bash
pnpm start:orchestrator
```

Agents run in-process. No Docker needed. Tool permissions and RBAC still apply. If the credential proxy is running, local agents route through it automatically for credential injection.

### Full stack (containers + proxy)

```bash
# Terminal 1: Start the credential proxy
pnpm start:proxy

# Terminal 2: Start the orchestrator
pnpm start:orchestrator
```

The orchestrator auto-provisions containers on first message to a sandboxed agent.

## Add Discord

Edit `config/config.yaml`:

```yaml
channels:
  discord:
    enabled: true
    token: ${DISCORD_TOKEN}
    bindings:
      - server: "YOUR_SERVER_ID"
        agent: main
        channels: "*"
```

Set `DISCORD_TOKEN` in `config/.env` or your environment.

## Verify

```bash
pnpm test                # run all 749 tests
pnpm start:orchestrator  # start and type a message
```

---

[Architecture](architecture) | [Configuration Reference](configuration)
