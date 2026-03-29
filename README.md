# Stockade

Multi-agent orchestrator for Claude with layered security. Agents run in containers with no secrets, no direct internet, and per-tool permission rules — but you can poke precise holes when you need to.

## Why Stockade

Existing Claude agent platforms force a choice: sandbox everything (safe but limited) or trust everything (flexible but risky). Stockade gives you **granular control** — each agent gets exactly the permissions it needs, enforced at multiple layers.

| | [OpenClaw](https://github.com/openclaw/openclaw) | [NanoClaw](https://github.com/qwibitai/nanoclaw) | Stockade |
|---|---|---|---|
| **Security model** | Application-level allowlists | Container isolation (all-or-nothing) | Layered: containers + RBAC + tool permissions + network policy |
| **Credential handling** | In-process, shared memory | OneCLI gateway injects at request time | MITM proxy injects per-route — agents never see secrets |
| **Network control** | None | Container isolation only | Deny-by-default allowlist per host/path/method |
| **Permission granularity** | Global allowlists | Per-group filesystem isolation | Per-agent, per-tool, per-path rules (`allow:Bash(git *)`) |
| **Multi-agent** | Single agent | Single agent per group | Hierarchical: orchestrator delegates to typed sub-agents |
| **Agent-to-agent** | N/A | N/A | Built-in `ask_agent` MCP tool with RBAC enforcement |
| **Channels** | WhatsApp | WhatsApp, Telegram, Discord, Slack, Gmail | Terminal, Discord (extensible) |
| **Codebase** | ~500k lines, 70+ deps | ~2k lines, minimal deps | ~8k lines, 3 packages, 491 tests |

## Architecture

```
User (Terminal / Discord)
  │
  ▼
Orchestrator ──── RBAC ──── Session Manager
  │
  ├── Local agents (in-process, Agent SDK)
  │
  └── Sandboxed agents ──► Container ──► Credential Proxy ──► Internet
                            (no secrets)   (injects per-route)  (allowlist only)
```

Three packages:

- **`orchestrator`** — Config, routing, RBAC, sessions, channels, dispatch, container lifecycle
- **`worker`** — HTTP server wrapping Agent SDK `query()`, runs inside containers
- **`proxy`** — MITM credential proxy: route-based secret injection, network policy, TLS interception

## Security Layers

**1. Container isolation** — Sandboxed agents run in Docker on an internal network. No direct internet access.

**2. Credential proxy** — All outbound HTTP goes through a MITM proxy that strips auth headers and injects credentials per route config. Agents never see API keys.

**3. Tool permissions** — Per-agent rules control which tools can access which paths:
```yaml
permissions:
  - "deny:Write(/config/**)"     # can't modify config
  - "allow:Bash(git *)"          # can run git commands
  - "allow:Read"                 # can read anything
```

**4. RBAC** — Users get roles that control which agents and tools they can access. Identity flows through the entire sub-agent chain.

**5. Network policy** — Deny-by-default allowlist. Each host/path/method combination is explicitly allowed or denied.

## Quick Start

```bash
git clone https://github.com/Dragooon/stockade.git
cd stockade
pnpm install

# Copy and edit config
cp config/config.example.yaml config/config.yaml
cp config/proxy.example.yaml config/proxy.yaml

# Add your API key
mkdir -p config/secrets
echo "your-anthropic-api-key" > config/secrets/anthropic-api-key

# Start
pnpm start:orchestrator
```

The default config runs all agents in containers with the credential proxy. Edit `config/config.yaml` to customize agents, channels, and permissions.

### Unsandboxed mode

To run agents locally without containers (simpler, less secure):

```yaml
agents:
  main:
    sandboxed: false    # runs in-process
```

### Discord

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

## Config

Single YAML file defines everything: agents, channels, RBAC, containers.

```yaml
agents:
  main:
    model: claude-sonnet-4-6
    tools: [Bash, Read, Write, Edit, Glob, Grep]
    subagents: [researcher, engineer]
    sandboxed: true
    permissions:
      - "deny:Write(/config/**)"
      - "allow:*"

  researcher:
    model: claude-haiku-4-5-20251001
    tools: [Read, WebSearch, WebFetch]
    sandboxed: true
    permissions:
      - "allow:Read"
      - "allow:WebSearch"
      - "allow:WebFetch"
```

See [`config/config.example.yaml`](config/config.example.yaml) for the full default config.

## Project Structure

```
stockade/
├── packages/
│   ├── orchestrator/    # Core: config, RBAC, sessions, routing, channels, containers
│   ├── worker/          # Container HTTP server (Hono + Agent SDK)
│   └── proxy/           # Credential proxy (HTTP MITM + SSH tunnel + gateway)
├── config/
│   ├── config.example.yaml   # Default sandboxed config
│   └── proxy.example.yaml    # Proxy + network policy config
└── data/                     # Runtime data (gitignored)
```

## Tests

```bash
pnpm test              # all packages
pnpm -F @stockade/orchestrator test   # orchestrator only
pnpm -F @stockade/proxy test          # proxy only
```

491 tests across 3 packages: orchestrator (386), proxy (87), worker (18).

## Requirements

- Node.js 22+
- pnpm
- Docker (for sandboxed agents)

## License

MIT
