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
│       ├── index.ts          — Entry point, starts channels + dispatch loop
│       ├── config.ts         — YAML config loader, env substitution, path resolution
│       ├── router.ts         — Scope → agent ID resolution
│       ├── dispatcher.ts     — Agent dispatch (SDK query() or HTTP to container)
│       ├── permissions.ts    — First-match-wins permission engine (allow/deny/ask)
│       ├── rbac.ts           — User identity + role-based access control
│       ├── gatekeeper.ts     — AI risk assessment for tool invocations
│       ├── sessions.ts       — SQLite session persistence
│       ├── skills.ts         — Skill sync from ~/.claude/skills/ to agent workspaces
│       ├── watch.ts          — Config hot-reload watcher
│       ├── agent-mcp.ts      — ask_agent MCP server (sub-agent delegation)
│       ├── channels/         — Terminal, Discord channel adapters
│       ├── containers/       — Docker container lifecycle management
│       ├── api/              — HTTP API (server, sessions endpoint)
│       ├── workers/          — Host worker process management
│       └── scheduler/        — Cron-based scheduled agent tasks
├── proxy/          — Credential proxy: MITM HTTPS, gateway API, network policy
│   └── src/
│       ├── index.ts          — Proxy entry point
│       ├── shared/           — Config, credentials, types (shared between HTTP/gateway)
│       ├── http/             — MITM proxy: header injection, cache markers, audit logging
│       ├── gateway/          — Gateway API: token auth, ref token issuance
│       ├── ssh/              — SSH proxy (port forwarding)
│       └── cli/              — apw CLI tool + read-claude-oauth.py utility
└── worker/         — Container agent worker (receives HTTP dispatch)
    └── src/
        ├── agent.ts          — Wraps Claude Code SDK session
        ├── server.ts         — HTTP server for dispatch
        ├── channel.ts        — Worker channel abstraction
        ├── session.ts        — Worker session state
        └── entrypoint.sh     — Docker entrypoint
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
5. Injects Anthropic prompt cache markers (system + conversation history)
6. Forwards to upstream; writes audit logs if `STOCKADE_AUDIT_LOG=1`

Provider overrides route specific keys to different backends (first glob match wins).

Ref tokens (`apw-ref:<key>:<nonce>`) let agents pass credentials in request bodies without seeing the real value — the proxy does literal string substitution before forwarding.

**Prompt cache injection** — automatic, no config needed. Last system block gets a 1-hour TTL; second-to-last user message gets 1-hour TTL (SDK bug workaround); last user message gets 5-minute ephemeral. Haiku uses standard ephemeral throughout (no extended TTL support).

**Audit logging** — set `STOCKADE_AUDIT_LOG=1` to write NDJSON to `~/.stockade/logs/`:
- `cache-meta.ndjson` — per-call token stats (input, cache_read, cache_create, latency, session/agent/scope)
- `requests.ndjson` — per-session system prompt snapshot (logged once per session ID)

## Development

```bash
pnpm install                 # Install deps
pnpm build                   # Build all packages
pnpm test                    # Run all tests (~724 passing)
pnpm start:orchestrator      # Start orchestrator (terminal channel)
pnpm start:proxy             # Start credential proxy
pnpm start:validate          # Validate config without starting
```

Dev mode: `pnpm start:orchestrator` uses tsx for direct TypeScript execution.

### Worker changes require a full rebuild

Host workers run the **compiled dist** (`packages/worker/dist/`), not TypeScript source. Changes to `packages/worker/src/` are not picked up by an orchestrator restart alone. Full sequence:

```bash
cd ~/.stockade/repo
pnpm --filter @stockade/worker build                              # Recompile dist/
docker build -f packages/worker/Dockerfile -t stockade/worker .  # Rebuild image (sandboxed agents)
echo "restart" > ~/.stockade/restart.signal                       # Restart orchestrator
```

All three steps are required: dist rebuild → Docker image → orchestrator restart.

## SDK Permission Interaction

The Claude Code SDK has a hardcoded safety check (`Mjz`) that blocks writes to `{cwd}/.claude/skills/`, `{cwd}/.claude/agents/`, and `{cwd}/.claude/commands/` regardless of `permissionMode` or the `PreToolUse` hook result. This check is in the SDK's `zy1()` function and runs unconditionally during Edit/Write tool execution — it cannot be bypassed via `allowDangerouslySkipPermissions` or allow rules.

**Fix (implemented 2026-04-06):** The dispatcher passes `sdkCwd = platformRoot` (not the agent workspace) as the `cwd` option to the worker's `query()` call. The SDK's `o1()` function returns this cwd as the project root used by `Mjz()`, so it checks `{platformRoot}/.claude/skills/` (which doesn't exist) instead of the actual agent workspace skills path. The agent workspace is passed as `addDir` so CLAUDE.md and skills still load correctly.

Relevant files:
- `packages/orchestrator/src/dispatcher.ts` — `sdkCwd`/`sdkAddDirs` logic
- `packages/worker/src/agent.ts` — passes `addDir` to `query()` options
- `packages/worker/src/types.ts` — `WorkerSessionRequest.addDir` field

The permission context (`agentCwd`) still uses the real agent workspace path for permission rule evaluation — only the SDK's internal cwd changes.

## Key Conventions

- TypeScript throughout, Zod for config validation
- Vitest for testing; unit tests mock, e2e tests use real infra (no mocks in e2e)
- Claude Code Agent SDK (`@anthropic-ai/claude-code-sdk`) for agent sessions
- `system_mode: append` uses SDK's Claude Code preset + appends custom system prompt
- Agent workspaces: `~/.stockade/agents/<agent-id>/`
- Sessions persisted in SQLite: `~/.stockade/sessions.db`
- Sub-agent sessions use in-memory map (not SQLite); do not persist across restarts
- Skills synced from `~/.claude/skills/` to agent workspaces on each dispatch (file copy, not symlinks)
- Env vars in config via `${VAR_NAME}` syntax, `~/` expansion in string values
- Logs: `~/.stockade/logs/` (cache-meta.ndjson, requests.ndjson when audit logging enabled)

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

**Workspace path overrides** — when the Docker host filesystem differs from the orchestrator's (e.g. WSL2), set on the agent's `container:` block:
- `workspace_path` — path relative to `agents_dir` (resolved on the host before passing to Docker)
- `workspace_host_path` — explicit host-side absolute path passed directly to Docker `-v`

Priority: `workspace_host_path` > `workspace_path` > `{agents_dir}/{agent_id}` (default).
