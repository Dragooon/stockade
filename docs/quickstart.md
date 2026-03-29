---
layout: default
title: Quick Start
---

# Quick Start

## Prerequisites

- Node.js 22+
- pnpm
- Docker (for sandboxed agents)
- An Anthropic API key

## Install

```bash
git clone https://github.com/Dragooon/stockade.git
cd stockade
pnpm install
```

## Configure

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

## Run

### Simple mode (no containers)

Set `sandboxed: false` on your agents in config.yaml:

```bash
pnpm start:orchestrator
```

Agents run in-process. No Docker needed. Less isolation.

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

Set `DISCORD_TOKEN` in `.env` or your environment.

## Verify

```bash
pnpm test              # run all 749 tests
pnpm start:orchestrator  # start and type a message
```

---

[Architecture](architecture) | [Configuration Reference](configuration)
