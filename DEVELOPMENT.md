# Stockade — Development Guide

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
│       ├── shared/           — Config, credentials, types
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

## Building and Running

```bash
pnpm install                 # Install deps
pnpm build                   # Build all packages
pnpm test                    # Run all tests (~724)
pnpm start:orchestrator      # Start orchestrator (terminal channel)
pnpm start:proxy             # Start credential proxy
pnpm start:validate          # Validate config without starting
```

Dev mode uses `tsx` for direct TypeScript execution — no build step needed for orchestrator changes.

### Worker changes require a full rebuild

Host workers run the **compiled dist** (`packages/worker/dist/`), not TypeScript source. Changes to `packages/worker/src/` are not picked up by an orchestrator restart alone:

```bash
pnpm --filter @stockade/worker build                              # Recompile dist/
docker build -f packages/worker/Dockerfile -t stockade/worker .  # Rebuild image (sandboxed agents)
echo "restart" > ~/.stockade/restart.signal                       # Restart orchestrator
```

All three steps are required: dist rebuild → Docker image → orchestrator restart.

## Config Hot Reload

The orchestrator watches `config.yaml` and `.env` for changes. When either file changes:
- Config is reloaded in-process
- Running containers are restarted with the new config

This means most config changes (agent definitions, permissions, RBAC) take effect without a full restart. Source code changes still require a restart via `bin/restart-orchestrator`.

## Prompt Cache Injection

The MITM proxy (`packages/proxy/src/http/proxy.ts`) automatically injects `cache_control` markers on every Anthropic API request. No agent or user configuration needed.

**What gets cached:**
- Last system block → 1-hour TTL (`scope:global` for Opus, standard 5-minute ephemeral for Haiku — Haiku rejects extended TTLs)
- Second-to-last user message → 1-hour TTL (workaround for SDK bug: the SDK marks the *last* user message but that position gets evicted; anchoring at second-to-last improves hit rate significantly)
- Last user message → 5-minute ephemeral (skipped if SDK already marked it)

Existing SDK-placed cache markers are upgraded to 1-hour TTL where possible.

## Audit Logging

Set `STOCKADE_AUDIT_LOG=1` in the proxy's environment to enable NDJSON logs at `~/.stockade/logs/`:

**`cache-meta.ndjson`** — one entry per API call:
```json
{"ts":"2026-04-06T10:00:00Z","session":"ses_abc","agent":"main","scope":"terminal:user","model":"claude-opus-4-6","input":1200,"output":450,"cache_read":8200,"cache_create":320,"cache_read_pct":87,"latency_ms":1840}
```

**`requests.ndjson`** — one entry per session (logged once, deduped by session ID):
```json
{"ts":"2026-04-06T10:00:00Z","session":"ses_abc","agent":"main","scope":"terminal:user","model":"claude-opus-4-6","system":[{"index":0,"type":"text","bytes":4200,"cache_control":{"type":"ephemeral"},"text":"..."}]}
```

The dispatcher injects `X-Stockade-Session`, `X-Stockade-Agent`, and `X-Stockade-Scope` custom headers — the proxy reads these for tagging and strips them before forwarding to Anthropic.

## Skills Sync

Agents can declare a `skills` list in their config. On each dispatch the orchestrator copies those skills from `~/.claude/skills/` into the agent's workspace (`.claude/skills/`). Uses file copy rather than symlinks for cross-filesystem compatibility (WSL2, Docker volumes).

```yaml
agents:
  main:
    skills: [tavily-search, gogcli, goplaces]
```

## Container Workspace Paths

When the Docker host filesystem differs from the orchestrator's filesystem (e.g. WSL2 where the orchestrator runs in Windows but Docker mounts from WSL2), use these container config overrides:

```yaml
agents:
  my-agent:
    container:
      workspace_path: my-agent              # relative to agents_dir — resolved on host
      workspace_host_path: /mnt/c/Users/...  # explicit host path passed to Docker
```

Priority: `workspace_host_path` > `workspace_path` > `{agents_dir}/{agent_id}` (default).

## Sub-Agent Sessions

Sub-agents (dispatched via `ask_agent` MCP) maintain session continuity across turns using an in-memory map keyed by `{parent_session}:{agent_id}`. Session IDs are logged on boot and in the dispatch path for debugging.

Sub-agent sessions are in-memory only and do not persist across orchestrator restarts (unlike top-level sessions which use SQLite).

## Testing

```bash
pnpm test                                    # all packages
pnpm --filter @stockade/orchestrator test    # orchestrator only (587 passing)
pnpm --filter @stockade/proxy test           # proxy only (125 passing)
pnpm --filter @stockade/worker test          # worker only (12 passing)
```

Unit tests mock external dependencies. E2E tests (`tests/integration/`) use real infra — no mocks. Some proxy credential tests require `op` CLI (1Password) and will be skipped or fail without it.

## Key Conventions

- TypeScript throughout, Zod for config validation
- Vitest for testing
- Claude Code Agent SDK (`@anthropic-ai/claude-code-sdk`) for agent sessions
- `system_mode: append` uses SDK's Claude Code preset + appends custom system prompt
- Agent workspaces: `~/.stockade/agents/<agent-id>/`
- Sessions persisted in SQLite: `~/.stockade/sessions.db`
- Env vars in config via `${VAR_NAME}` syntax, `~/` expansion in string values
- Logs: `~/.stockade/logs/` (cache-meta.ndjson, requests.ndjson when audit logging enabled)
