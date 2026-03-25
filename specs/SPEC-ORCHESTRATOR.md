# SPEC: Orchestrator (`packages/orchestrator`)

## Purpose

Central coordinator. Manages agent processes, sessions, RBAC, and config. Routes channel messages to the right agent with the right context. Knows about users, permissions, and sessions — but delegates all LLM execution to agents.

## HTTP API

### Inbound (from channels)

```
POST /api/message
  Request:  { scope: string, content: string, userId: string, platform: string, metadata?: object }
  Response: { response: string, sessionId: string }
```

### Inbound (from agents, for sub-agent spawning)

```
POST /api/subagent
  Request:  { parentSessionId: string, agentId: string, task: string, context?: string }
  Response: { result: string }
```

### Queries

```
GET /api/sessions/:scope  — { session: SessionRecord, messageCount: number }
GET /api/health           — { ok: true }
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `next` | API routes (app router) |
| `@casl/ability` | RBAC permission checks |
| `better-sqlite3` + `drizzle-orm` | Session + message persistence |
| `js-yaml` | YAML config parsing |
| `zod` | Config validation |
| `execa` | Spawn host agent processes |
| `dockerode` | Spawn Docker containers for sandboxed agents |
| `vitest` | Testing |

## File Structure

```
packages/orchestrator/
├── src/
│   ├── app/
│   │   └── api/
│   │       ├── message/route.ts       — Main message handler
│   │       ├── subagent/route.ts      — Sub-agent spawning endpoint
│   │       ├── sessions/
│   │       │   └── [scope]/route.ts   — Session query endpoint
│   │       └── health/route.ts
│   ├── lib/
│   │   ├── config.ts                  — YAML loader + Zod validation
│   │   ├── rbac.ts                    — CASL ability builder
│   │   ├── sessions.ts               — Session CRUD operations
│   │   ├── agents.ts                  — Agent process lifecycle management
│   │   ├── router.ts                  — Scope → agent resolution
│   │   ├── agent-client.ts            — HTTP client for agent /run calls
│   │   └── db/
│   │       ├── schema.ts              — Drizzle table definitions
│   │       └── index.ts               — DB connection singleton
│   └── types.ts
├── tests/
│   ├── config.test.ts
│   ├── rbac.test.ts
│   ├── sessions.test.ts
│   ├── router.test.ts
│   ├── agents.test.ts
│   ├── agent-client.test.ts
│   └── message-handler.test.ts
├── package.json
├── next.config.ts
├── tsconfig.json
└── vitest.config.ts
```

## Component Details

### Config Loader (`lib/config.ts`)

Loads two YAML files and validates with Zod:

```typescript
// config/agents.yaml
interface AgentsConfig {
  agents: Record<string, {
    model: string                // "claude-sonnet-4-20250514"
    provider: string             // "anthropic"
    system: string               // system prompt
    tools: string[]              // ["bash", "file-read", ...]
    mcp?: MCPServerConfig[]      // MCP server definitions
    sandbox: boolean             // run in Docker?
    lifecycle: 'persistent' | 'ephemeral'
    port?: number                // for persistent agents
    memory?: { dir: string }     // memory directory path
    docker?: {                   // only if sandbox: true
      image: string
      network?: string
    }
  }>
}

// config/platform.yaml
interface PlatformConfig {
  channels: {
    terminal?: { enabled: boolean, agent: string }
    discord?: {
      enabled: boolean
      token: string              // supports ${ENV_VAR} substitution
      bindings: Array<{
        server: string           // Discord server ID
        agent: string            // agent ID to route to
        channels: string | string[]  // "*" or specific channel IDs
      }>
    }
  }
  rbac: {
    roles: Record<string, {
      permissions: string[]      // ["agent:*", "tool:bash", "agent:main"]
    }>
    users: Record<string, {
      roles: string[]
      identities: Record<string, string>  // { discord: "user_id", terminal: "username" }
    }>
  }
}
```

Features:
- Environment variable substitution: `${VAR}` in YAML values
- Zod validation with clear error messages
- `loadConfig()` returns typed, validated config
- Optional: file watcher for hot-reload

### Database (`lib/db/`)

Drizzle schema:

```typescript
const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),          // UUID
  scope: text('scope').notNull().unique(),  // "discord:123:456:789"
  agentId: text('agent_id').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),          // UUID
  sessionId: text('session_id').notNull().references(() => sessions.id),
  role: text('role').notNull(),          // "user" | "assistant" | "tool" | "system"
  content: text('content').notNull(),    // JSON-serialized CoreMessage content
  createdAt: integer('created_at').notNull(),
})
```

DB file location: `data/platform.db` (configurable).

### Session Manager (`lib/sessions.ts`)

```typescript
function getOrCreateSession(scope: string, agentId: string): SessionRecord
function getMessages(sessionId: string): CoreMessage[]
function saveMessages(sessionId: string, newMessages: CoreMessage[]): void
function deleteSession(scope: string): void
```

Messages stored as JSON-serialized CoreMessage content. On load, reconstructed into Vercel AI SDK format.

### RBAC (`lib/rbac.ts`)

Build CASL ability from config:

```typescript
function buildAbility(userId: string, platform: string, config: PlatformConfig): Ability

function checkAccess(userId: string, platform: string, agentId: string): boolean
// 1. Resolve user: find config user by platform identity
// 2. Get roles for user
// 3. Check if any role grants "agent:<agentId>" or "agent:*"

function checkToolAccess(roles: string[], toolName: string): boolean
// Check if roles grant "tool:<toolName>" or "tool:*"
```

Unknown users are denied by default.

### Router (`lib/router.ts`)

```typescript
function resolveAgent(scope: string, config: PlatformConfig): string
// 1. Parse scope: "discord:server:channel:user" → { platform, server, channel, user }
// 2. Look up channel bindings in config
// 3. Match server + channel (support wildcards "*")
// 4. Return agentId
// Throws if no binding matches
```

### Agent Client (`lib/agent-client.ts`)

HTTP client for calling agent /run endpoint:

```typescript
async function sendToAgent(agentUrl: string, request: RunRequest): Promise<RunResponse>
// POST to agentUrl/run with JSON body
// Handle timeout (default 120s)
// Wrap errors with context (agent URL, status code)
```

### Agent Lifecycle (`lib/agents.ts`)

```typescript
class AgentManager {
  // Start a persistent agent as a child process
  async startPersistent(agentId: string, config: AgentConfig): Promise<AgentHandle>

  // Spawn an ephemeral agent for a single task
  async spawnEphemeral(agentId: string, config: AgentConfig, task: string): Promise<string>

  // Stop an agent
  async stop(agentId: string): Promise<void>

  // Stop all agents
  async stopAll(): Promise<void>

  // Get running agent URL
  getAgentUrl(agentId: string): string | undefined
}

interface AgentHandle {
  process: ChildProcess | Container
  port: number
  url: string
}
```

For persistent agents: spawn via `execa('node', ['packages/agent/dist/index.js'], { env: { PORT, AGENT_ID, MODEL, ... } })`, poll /health until ready.

For sandboxed ephemeral agents: create Docker container via `dockerode`, run task, collect output, remove container.

### Message Handler (`app/api/message/route.ts`)

The main flow:

```typescript
export async function POST(request: Request) {
  const body = await request.json()  // { scope, content, userId, platform }

  // 1. RBAC
  const agentId = resolveAgent(body.scope, config)
  if (!checkAccess(body.userId, body.platform, agentId)) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 })
  }

  // 2. Session
  const session = getOrCreateSession(body.scope, agentId)
  const messages = getMessages(session.id)

  // 3. Build request for agent
  messages.push({ role: 'user', content: body.content })
  const agentUrl = agentManager.getAgentUrl(agentId)
  const agentConfig = config.agents[agentId]

  // 4. Call agent
  const result = await sendToAgent(agentUrl, {
    messages,
    systemPrompt: agentConfig.system,
  })

  // 5. Persist
  saveMessages(session.id, result.messages)

  // 6. Extract assistant response
  const lastAssistant = result.messages.findLast(m => m.role === 'assistant')
  return Response.json({
    response: lastAssistant?.content ?? '',
    sessionId: session.id,
  })
}
```

### Sub-agent Handler (`app/api/subagent/route.ts`)

```typescript
export async function POST(request: Request) {
  const { parentSessionId, agentId, task, context } = await request.json()

  // RBAC: check parent session's user can access the sub-agent
  // Spawn ephemeral agent
  // Send task as single user message
  // Collect result, kill agent
  // Return result
}
```

## Tasks (implementation order)

### T2.1: Scaffolding
- Init Next.js app (app router, API-only — no pages/layouts needed)
- Install all deps
- `vitest.config.ts` (separate from Next.js)
- Build/dev/test scripts

### T2.2: Types (`types.ts`)
- ChannelMessage, SessionRecord, MessageRecord
- AgentsConfig, PlatformConfig (matching YAML structure)
- Re-export relevant types from agent package

### T2.3: Config loader + tests
- YAML parsing, Zod validation schemas
- ${ENV_VAR} substitution
- Tests: valid, invalid, missing env, env substitution

### T2.4: Database schema + connection
- Drizzle schema (sessions, messages tables)
- DB singleton with auto-migration
- Tests: table creation, basic CRUD

### T2.5: Session manager + tests
- getOrCreateSession, getMessages, saveMessages
- CoreMessage serialization/deserialization
- Tests: create, load, append, delete

### T2.6: RBAC engine + tests
- CASL ability builder from config
- Identity resolution (platform user ID → config user)
- Tests: owner grants, user restrictions, unknown user denied, wildcard permissions

### T2.7: Router + tests
- Scope parsing, binding matching
- Wildcard support
- Tests: exact match, wildcard, no match

### T2.8: Agent client + tests
- HTTP client for /run
- Timeout + error handling
- Tests: mock HTTP responses

### T2.9: Agent lifecycle manager + tests
- Start persistent (execa)
- Spawn ephemeral (execa or dockerode)
- Health polling, stop, stopAll
- Tests: mock execa/dockerode

### T2.10: Message handler route + tests
- Full flow: parse → RBAC → route → session → agent → persist → respond
- Error cases: unauthorized, no agent, agent error
- Tests: mocked dependencies, full flow

### T2.11: Sub-agent handler route + tests
- Spawn ephemeral, run task, return result
- Tests: success flow, RBAC denied

## Testing Strategy

- **Unit tests**: Each lib/ module tested in isolation with mocked dependencies
- **Integration test**: Message handler with real DB but mocked agent HTTP
- **No actual LLM calls**: Agent client is mocked in orchestrator tests
- **Temp DB**: Each test gets a fresh SQLite DB via `beforeEach`
