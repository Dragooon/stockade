# Agent Platform V2 — Agent SDK Rewrite

## Architecture Change

V1 had three HTTP-communicating packages (~3,000 LOC, 187 tests).
V2 collapses this to two packages (~800-1000 LOC) by leveraging the Agent SDK.

```
V1:                                    V2:
Channel → HTTP → Orchestrator          Orchestrator (single process)
                  → HTTP → Agent         ├── Channels (Discord, Terminal)
                                         ├── Config + RBAC + Sessions
                                         └── Dispatcher → in-process query()
                                                        → HTTP to Worker

                                        Worker (containerizable)
                                         └── HTTP wrapper around Agent SDK query()
```

## Package Structure

```
packages/
├── orchestrator/              — Main brain (single process)
│   ├── src/
│   │   ├── index.ts           — Entry point: boot config, channels, dispatch
│   │   ├── config.ts          — YAML loader + Zod validation (reuse V1)
│   │   ├── types.ts           — All shared types
│   │   ├── rbac.ts            — User identity + permission hooks
│   │   ├── sessions.ts        — Scope → Agent SDK sessionId mapping (SQLite)
│   │   ├── dispatcher.ts      — Route to in-process query() or HTTP worker
│   │   └── channels/
│   │       ├── discord.ts     — Discord adapter (merged from V1 channels pkg)
│   │       └── terminal.ts    — Terminal REPL adapter
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
│
└── worker/                    — Standalone agent process (containerizable)
    ├── src/
    │   ├── index.ts           — Entry: HTTP server on configurable port
    │   └── agent.ts           — Agent SDK query() wrapper with config
    ├── tests/
    ├── package.json
    ├── Dockerfile             — For container deployment
    └── tsconfig.json
```

## How It Works

### Message Flow

```
User message (Discord/Terminal)
  → Channel adapter builds scope + ChannelMessage
  → Orchestrator:
      1. resolveAgent(scope, config) → agentId
      2. checkAccess(userId, platform, agentId) → boolean
      3. buildPermissionHook(userId, config) → can_use_tool callback
      4. getSessionId(scope) → Agent SDK session ID (or null for new)
      5. dispatch(agentId, message, sessionId, permissionHook):
         ├── persistent/in-process: Agent SDK query() directly
         └── remote/containerized: HTTP POST to worker
      6. Store returned sessionId for scope
  → Response back to channel
```

### Worker (agent process)

The worker is a thin HTTP wrapper around Agent SDK `query()`:

```typescript
// POST /run
// Request: { prompt, systemPrompt, tools, model, sessionId?, permissionMode }
// Response: { result, sessionId, messages }

app.post("/run", async (c) => {
  const req = await c.req.json();

  const messages = [];
  let sessionId = null;
  let result = "";

  for await (const msg of query({
    prompt: req.prompt,
    options: {
      model: req.model ?? "sonnet",
      systemPrompt: req.systemPrompt,
      allowedTools: req.tools,
      resume: req.sessionId ?? undefined,
      maxTurns: req.maxTurns ?? 20,
    }
  })) {
    messages.push(msg);
    if (msg.session_id) sessionId = msg.session_id;
    if ("result" in msg) result = msg.result;
  }

  return c.json({ result, sessionId, messages });
});
```

That's essentially the entire worker. ~30 lines of real logic.

### Dispatcher

```typescript
async function dispatch(agentId: string, opts: DispatchOptions): Promise<DispatchResult> {
  const agentConfig = config.agents[agentId];

  if (agentConfig.lifecycle === "persistent" && agentConfig.remote) {
    // Remote worker — HTTP POST
    const workerUrl = agentConfig.url ?? `http://localhost:${agentConfig.port}`;
    return await sendToWorker(workerUrl, opts);
  }

  // In-process — direct Agent SDK query()
  const messages = [];
  for await (const msg of query({
    prompt: opts.prompt,
    options: {
      model: agentConfig.model,
      systemPrompt: agentConfig.system,
      allowedTools: agentConfig.tools,
      resume: opts.sessionId ?? undefined,
      canUseTool: opts.permissionHook,
      maxTurns: agentConfig.maxSteps ?? 20,
    }
  })) {
    messages.push(msg);
  }
  // extract result + sessionId from messages
}
```

### RBAC → Permission Hooks

The key innovation: RBAC config translates into Agent SDK `can_use_tool` callbacks:

```typescript
function buildPermissionHook(userId: string, platform: string, config: PlatformConfig) {
  const user = resolveUser(userId, platform, config);
  const roles = user?.roles ?? [];
  const permissions = roles.flatMap(r => config.rbac.roles[r]?.permissions ?? []);

  return async (tool: string, input: Record<string, unknown>) => {
    // Check tool-level permissions
    if (permissions.includes("tool:*")) return { type: "allow" };
    if (permissions.includes(`tool:${tool}`)) return { type: "allow" };

    // Pattern matching on commands (e.g., "tool:bash:git*")
    for (const perm of permissions) {
      if (matchesToolPattern(perm, tool, input)) return { type: "allow" };
    }

    return { type: "deny", message: `Permission denied: ${tool}` };
  };
}
```

### Sessions

Simple SQLite table mapping scope → Agent SDK session ID:

```typescript
// scope: "discord:123:456:789" → sessionId: "sdk-session-abc123"
function getSessionId(scope: string): string | null
function setSessionId(scope: string, sessionId: string): void
function deleteSession(scope: string): void
```

No message storage needed — the Agent SDK handles conversation persistence internally.

## Config Format (unchanged from V1)

`config/agents.yaml` gains `remote` and `url` fields:

```yaml
agents:
  main:
    model: claude-sonnet-4-20250514
    system: |
      You are a helpful assistant.
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
    lifecycle: persistent
    remote: false           # in-process

  researcher:
    model: claude-haiku-4-5-20251001
    system: |
      You are a research agent.
    tools: ["Bash", "Read", "Glob", "Grep", "WebSearch", "WebFetch"]
    lifecycle: persistent
    remote: true            # separate process/container
    port: 3001
    url: http://localhost:3001   # or container hostname
```

`config/platform.yaml` — unchanged from V1.

## What Gets Deleted From V1

| V1 Component | Replaced By |
|--------------|-------------|
| `packages/agent/` (50 tests) | `packages/worker/` (~5 tests, ~100 LOC) |
| `packages/channels/` (60 tests) | Merged into `packages/orchestrator/channels/` |
| Custom tools (bash, file-read, file-write, file-edit) | Agent SDK built-in tools |
| AgentRunner + compaction + memory | Agent SDK `query()` + sessions |
| Agent HTTP server (Hono, 4 endpoints) | Worker: 2 endpoints |
| Session DB (messages table, CoreMessage serialization) | Agent SDK internal sessions |
| Agent client (HTTP to /run) | Dispatcher (HTTP or in-process) |

## What Gets Kept/Adapted From V1

| V1 Component | Status |
|--------------|--------|
| Config loader (YAML + Zod) | Adapted (new agent schema fields) |
| RBAC engine | Adapted → builds can_use_tool hooks |
| Router (scope → agent) | Kept as-is |
| Discord adapter | Moved into orchestrator |
| Terminal adapter | Moved into orchestrator |
| Scope utilities | Kept as-is |

## Implementation Tasks

### Worker (tiny)
- W1: Scaffolding (package.json, tsconfig, Dockerfile)
- W2: Types (RunRequest, RunResponse)
- W3: Agent wrapper (Agent SDK query() with config) + tests
- W4: HTTP server (POST /run, GET /health) + tests

### Orchestrator
- O1: Scaffolding (package.json, tsconfig, vitest)
- O2: Types (all shared types)
- O3: Config loader (adapted from V1 with new fields) + tests
- O4: Sessions store (scope → sessionId, SQLite) + tests
- O5: RBAC → permission hooks (buildPermissionHook) + tests
- O6: Dispatcher (in-process + HTTP) + tests
- O7: Terminal adapter (from V1 channels) + tests
- O8: Discord adapter (from V1 channels) + tests
- O9: Entry point + integration wiring
