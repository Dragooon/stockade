# Stockade

[**dragooon.github.io/stockade**](https://dragooon.github.io/stockade/)

> **Alpha software.** Architecture is stable and tested (749 tests), but APIs and config format may change. Not yet recommended for production use.

Multi-agent orchestrator for Claude with layered security. Agents run in containers with no secrets, no direct internet, and per-tool permission rules — but you can poke precise holes when you need to.

## Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Security Layers](#security-layers)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Comparison](#comparison)
- [Tests](#tests)

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

The default config runs all agents sandboxed in containers. Edit `config/config.yaml` to customize.

To run agents locally without containers (simpler, less secure), set `sandboxed: false` on any agent.

## Architecture

```mermaid
graph TD
    User["User (Terminal / Discord)"]
    Orch["Orchestrator"]
    RBAC["RBAC"]
    Sessions["Session Manager"]
    Local["Local Agent<br/>(in-process)"]
    Container["Container<br/>(no secrets)"]
    Proxy["Credential Proxy<br/>(injects per-route)"]
    Internet["Internet<br/>(allowlist only)"]

    User --> Orch
    Orch --- RBAC
    Orch --- Sessions
    Orch --> Local
    Orch --> Container
    Container --> Proxy
    Proxy --> Internet

    style Container fill:#1a1a2e,stroke:#4fc3f7,color:#e0e0e0
    style Proxy fill:#1a1a2e,stroke:#4fc3f7,color:#e0e0e0
    style RBAC fill:#0d1117,stroke:#888,color:#e0e0e0
    style Sessions fill:#0d1117,stroke:#888,color:#e0e0e0
```

Three packages:

| Package | Role |
|---|---|
| **`orchestrator`** | Config, routing, RBAC, sessions, channels, dispatch, container lifecycle |
| **`worker`** | HTTP server wrapping Agent SDK `query()`, runs inside containers |
| **`proxy`** | MITM credential proxy: route-based secret injection, network policy, TLS interception |

### Message flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Channel
    participant O as Orchestrator
    participant R as RBAC
    participant A as Agent Container
    participant P as Proxy
    participant API as api.anthropic.com

    U->>C: message
    C->>O: route
    O->>R: check permissions
    R-->>O: allowed
    O->>A: POST /run (no secrets)
    A->>P: HTTPS request
    P->>P: strip auth headers
    P->>P: inject API key
    P->>API: authenticated request
    API-->>P: response
    P-->>A: response
    A-->>O: result
    O-->>C: reply
    C-->>U: response
```

### Sub-agent delegation

```mermaid
graph LR
    Main["main<br/>(orchestrator)"]
    Researcher["researcher<br/>(sandboxed)"]
    Engineer["engineer<br/>(sandboxed)"]

    Main -->|"ask_agent"| Researcher
    Main -->|"ask_agent"| Engineer

    style Main fill:#1a1a2e,stroke:#4fc3f7,color:#e0e0e0
    style Researcher fill:#0d1117,stroke:#888,color:#e0e0e0
    style Engineer fill:#0d1117,stroke:#888,color:#e0e0e0
```

The orchestrator delegates to sub-agents via the `ask_agent` MCP tool. RBAC is enforced through the entire chain — the original caller's identity flows through every hop.

## Security Layers

**1. Container isolation** — Sandboxed agents run in Docker on an internal network. No direct internet access.

**2. Credential proxy** — All outbound HTTP goes through a MITM proxy that strips auth headers and injects credentials per route. Agents never see API keys.

**3. Tool permissions** — Per-agent rules control which tools can access which paths:
```yaml
permissions:
  - "deny:Write(/config/**)"     # can't modify config
  - "allow:Bash(git *)"          # can run git commands
  - "allow:Read"                 # can read anything
```

**4. RBAC** — Users get roles that control which agents and tools they can access. Identity flows through the entire sub-agent chain.

**5. Network policy** — Deny-by-default allowlist. Each host/path/method combination is explicitly allowed or denied.

## Configuration

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

See [`config/config.example.yaml`](config/config.example.yaml) for the full default config and [`config/proxy.example.yaml`](config/proxy.example.yaml) for network policy.

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

## Comparison

| | [OpenClaw](https://github.com/openclaw/openclaw) | [NanoClaw](https://github.com/qwibitai/nanoclaw) | [NemoClaw](https://github.com/NVIDIA/NemoClaw) | Stockade |
|---|---|---|---|---|
| **Isolation** | Optional containers, app-level permissions | Container per group | Landlock + seccomp + netns | Container + RBAC + tool permissions + network policy |
| **Credentials** | In-process | Gateway injection | Host-only via OpenShell | MITM proxy, per-route, zero secrets in container |
| **Multi-agent** | Single | Single per group | Single (wraps OpenClaw) | Hierarchical delegation with `ask_agent` MCP |
| **Codebase** | ~500k lines | ~2k lines | Thin CLI over OpenClaw | ~8k lines, 749 tests |
| **Status** | Production | Production | Alpha | Alpha |

## Tests

```bash
pnpm test              # all packages
pnpm -F @stockade/orchestrator test   # orchestrator only
pnpm -F @stockade/proxy test          # proxy only
```

749 tests across 3 packages: orchestrator (614), proxy (117), worker (18).

## Requirements

- Node.js 22+
- pnpm
- Docker (for sandboxed agents)

## License

MIT
