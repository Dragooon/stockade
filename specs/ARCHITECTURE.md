# Agent Platform — Architecture Overview

## Layers

Three independent layers, each its own package in a pnpm workspace monorepo.

```
packages/
├── agent/              — Layer 1: Agent execution runtime
├── orchestrator/       — Layer 2: Central coordinator (Next.js)
└── channels/           — Layer 3: Platform adapters (Terminal, Discord)
```

## Interface Contracts

### Channel → Orchestrator

```typescript
POST /api/message
Request: {
  scope: string          // "discord:123:456:789"
  content: string        // user message text
  userId: string         // platform user ID
  platform: string       // "discord" | "terminal"
  metadata?: Record<string, unknown>
}
Response: { response: string, sessionId: string }
```

### Orchestrator → Agent

```typescript
POST /run
Request: {
  messages: CoreMessage[]   // Vercel AI SDK message format
  systemPrompt: string      // system prompt + injected memory
  config?: {
    model?: string
    maxSteps?: number
  }
}
Response: { messages: CoreMessage[], usage: object, finishReason: string }

POST /run/stream — same request, SSE response
GET  /health     — { ok: true, agentId: string }
GET  /tools      — { tools: ToolDefinition[] }
```

### Agent → Orchestrator (sub-agent callback)

```typescript
POST /api/subagent
Request: {
  parentSessionId: string
  agentId: string
  task: string
  context?: string
}
Response: { result: string }
```

## Stack

- **Language**: TypeScript throughout
- **Agent SDK**: Vercel AI SDK v6 (ToolLoopAgent, tool(), MCP)
- **LLM Provider**: @ai-sdk/anthropic (Claude)
- **HTTP**: Hono (agent), Next.js (orchestrator)
- **DB**: better-sqlite3 + drizzle-orm
- **RBAC**: @casl/ability
- **Config**: js-yaml + zod validation
- **Discord**: discord.js
- **Process mgmt**: execa (host), dockerode (Docker)
- **Testing**: vitest
- **Monorepo**: pnpm workspaces

## Config Files

Two YAML files in `config/`:

- `agents.yaml` — agent definitions (model, tools, sandbox, lifecycle, memory)
- `platform.yaml` — channels, RBAC roles/users, channel→agent bindings

## Data

Runtime data lives in `data/` (gitignored):

- `data/platform.db` — sessions + messages (SQLite)
- `data/agents/<agent_id>/memory/` — per-agent memory files

## Implementation Order

1. **Agent** (no dependencies on other layers)
2. **Orchestrator** (depends on Agent HTTP contract only)
3. **Channels** (depends on Orchestrator HTTP contract only)

## Agent Lifecycle

- **Persistent agents**: long-running Node servers, started by orchestrator at boot
- **Ephemeral agents**: spawned per-task (sub-agents), killed on completion
- **Sandboxed agents**: run in Docker containers (ephemeral only)
