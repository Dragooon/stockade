# Stockade — Agent Platform

Multi-agent orchestrator for Claude with layered security. Agents run in containers with no secrets, per-tool permissions, and a credential-injecting MITM proxy.

## Architecture

```
User (Terminal / Discord)
  ↓
Orchestrator  →  Router (scope → agent)  →  Dispatcher (query / HTTP)
  ↓                                            ↓
RBAC (user identity flows through chain)   Agent (Claude Code SDK session)
  ↓                                            ↓
Permissions (first-match-wins rules)       Credential Proxy (MITM, inject per-route)
  ↓                                            ↓
Gatekeeper (AI risk review for ask rules)  Network Policy (deny-by-default allowlist)
```

Key flow: message arrives on a channel → router resolves scope to agent ID → RBAC checks user access → dispatcher launches agent (in-process or container) → agent runs tools with permission checks → gatekeeper reviews `ask` rules → credential proxy injects secrets on the wire.

## Package Structure

```
packages/
├── orchestrator/   — Core: config, routing, dispatch, permissions, RBAC, gatekeeper, channels
│   └── src/
│       ├── index.ts        — Entry point, starts channels + dispatch loop
│       ├── config.ts       — YAML config loader, env substitution, path resolution
│       ├── router.ts       — Scope → agent ID resolution
│       ├── dispatcher.ts   — Agent dispatch (SDK query() or HTTP to container)
│       ├── permissions.ts  — First-match-wins permission engine (allow/deny/ask)
│       ├── rbac.ts         — User identity + role-based access control
│       ├── gatekeeper.ts   — AI risk assessment for tool invocations
│       ├── sessions.ts     — SQLite session persistence
│       ├── channels/       — Terminal, Discord channel adapters
│       ├── containers/     — Docker container lifecycle management
│       └── scheduler/      — Cron-based scheduled agent tasks
├── proxy/          — Credential proxy: MITM HTTPS, gateway API, network policy
│   └── src/
│       ├── index.ts        — Proxy entry point
│       ├── shared/         — Config, credentials, types (shared between HTTP/gateway)
│       ├── http/           — MITM proxy: header injection, body rewriting (ref tokens)
│       ├── gateway/        — Gateway API: token auth, ref token issuance
│       ├── ssh/            — SSH proxy (port forwarding)
│       └── cli/apw         — CLI tool for agents to request ref tokens
└── worker/         — Container agent worker (receives HTTP dispatch)
    └── src/
        ├── agent.ts        — Wraps Claude Code SDK session
        ├── server.ts       — HTTP server for dispatch
        └── entrypoint.sh   — Docker entrypoint
```

## Config Location

Live config lives in `~/.stockade/` (decoupled from the source repo):
- `~/.stockade/config.yaml` — agents, channels, RBAC, containers, gatekeeper
- `~/.stockade/proxy.yaml` — credential provider, network policy, HTTP/SSH routes
- `~/.stockade/secrets/` — file-based credential store
- `~/.stockade/proxy/` — TLS certs (ca.crt, ca.key, ssh-ca)

Example configs in `config/` are templates for new users. Never commit real config or secrets.

## Permission System

First-match-wins rules per agent. Default when no rule matches: `ask` (HITL approval).

```yaml
permissions:
  - "deny:Write(/config/**)"    # /prefix = platform root (~/.stockade)
  - "ask:Bash(rm *)"            # Glob match on command
  - "allow:*"                   # Catchall — allow everything else
```

Path prefixes: `/` = platform root, `~/` = home, `./` = agent cwd, `//` = absolute POSIX.

## Gatekeeper

AI-powered risk classification for tool invocations that hit `ask` rules. Configured in `config.yaml`:

```yaml
gatekeeper:
  enabled: true
  agent: gatekeeper        # References an agent defined in the agents section
  auto_approve_risk: low   # Auto-approve low risk; medium+ prompts user
```

Risk levels: `low`, `medium`, `high`, `critical`. The gatekeeper agent's system prompt controls classification logic. When the gatekeeper can't run (no API key, errors), defaults to `medium`.

## Credential Proxy

MITM proxy that intercepts agent HTTPS traffic:
1. Strips auth headers from agent requests
2. Matches request host to route config
3. Resolves credential via provider (file, 1Password, OAuth, etc.)
4. Injects credential into the correct header
5. Forwards to upstream

Provider overrides route specific keys to different backends (first glob match wins).

Ref tokens (`apw-ref:<key>:<nonce>`) let agents pass credentials in request bodies without seeing the real value — the proxy does literal string substitution before forwarding.

## Development

```bash
pnpm install                 # Install deps
pnpm build                   # Build all packages
pnpm test                    # Run all tests (749+)
pnpm start:orchestrator      # Start orchestrator (terminal channel)
pnpm start:proxy             # Start credential proxy
pnpm start:validate          # Validate config without starting
```

Dev mode: `pnpm start:orchestrator` uses tsx for direct TypeScript execution.

## Key Conventions

- TypeScript throughout, Zod for config validation
- Vitest for testing; unit tests mock, e2e tests use real infra (no mocks in e2e)
- Claude Code Agent SDK (`@anthropic-ai/claude-code-sdk`) for agent sessions
- `system_mode: append` uses SDK's Claude Code preset + appends custom system prompt
- Agent workspaces: `~/.stockade/agents/<agent-id>/`
- Sessions persisted in SQLite: `~/.stockade/sessions.db`
- Env vars in config via `${VAR_NAME}` syntax, `~/` expansion in string values

## RBAC

User identity flows through the entire sub-agent delegation chain. Roles define tool permissions that apply at every level:

```yaml
rbac:
  roles:
    owner:
      permissions: ["agent:*", "tool:*"]
    user:
      permissions: ["agent:main"]
      deny: ["tool:Bash", "tool:Write"]
  users:
    username:
      roles: [owner]
      identities:
        discord: "discord-user-id"
        terminal: "os-username"
```

## Channels

- **Terminal**: stdin/stdout, scope format `terminal:<username>`
- **Discord**: Bot integration, scope format `discord:<server>:<channel>:<user>`
  - Shared channel awareness: agents receive ALL messages, must use judgment on when to respond
  - Bindings map servers/channels to agents

## Container Isolation

Sandboxed agents run in Docker on an internal network (`stockade-net`). The credential proxy is their only route out. Container lifecycle managed by `ContainerManager` — auto-provisioning, health checks, and cleanup.
