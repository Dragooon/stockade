# SPEC: Agent Layer (`packages/agent`)

## Purpose

Self-contained agent execution runtime. A Node HTTP server that receives conversation turns via HTTP and returns responses. Knows nothing about sessions, channels, users, or permissions — those are orchestrator concerns.

The agent receives messages, runs an LLM loop with tools, and returns the result. That's it.

## HTTP API

```
POST /run          — Execute a conversation turn
  Request:  { messages: CoreMessage[], systemPrompt: string, config?: { model?, maxSteps? } }
  Response: { messages: CoreMessage[], usage: object, finishReason: string }

POST /run/stream   — Same but returns SSE stream

GET  /health       — { ok: true, agentId: string }

GET  /tools        — { tools: ToolDefinition[] }
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `ai` | Vercel AI SDK v6 — ToolLoopAgent, tool(), streaming |
| `@ai-sdk/anthropic` | Claude provider |
| `zod` | Tool input schema validation |
| `hono` | Lightweight HTTP server |
| `execa` | Shell command execution (for bash tool) |
| `vitest` | Testing |

## File Structure

```
packages/agent/
├── src/
│   ├── index.ts              — Entry point, starts Hono server on configured port
│   ├── server.ts             — Hono app with routes (/run, /run/stream, /health, /tools)
│   ├── runner.ts             — AgentRunner class wrapping Vercel AI SDK ToolLoopAgent
│   ├── compaction.ts         — Token counting + message summarization
│   ├── memory.ts             — Read memory dir, format for system prompt injection
│   ├── tools/
│   │   ├── index.ts          — Tool registry: getTools(names) → tool map
│   │   ├── bash.ts           — Shell command execution
│   │   ├── file-read.ts      — Read file contents with line numbers
│   │   ├── file-write.ts     — Write/create files
│   │   └── file-edit.ts      — Find-and-replace in files
│   └── types.ts              — RunRequest, RunResponse, AgentConfig, ToolDefinition
├── tests/
│   ├── runner.test.ts        — Agent loop with mocked LLM provider
│   ├── compaction.test.ts    — Compaction threshold + summarization logic
│   ├── memory.test.ts        — Memory file loading
│   ├── server.test.ts        — HTTP endpoint integration tests
│   └── tools/
│       ├── bash.test.ts
│       ├── file-read.test.ts
│       ├── file-write.test.ts
│       └── file-edit.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Component Details

### AgentRunner (`runner.ts`)

Wraps Vercel AI SDK's ToolLoopAgent (or generateText with stopWhen).

```typescript
class AgentRunner {
  constructor(config: AgentConfig)

  // Execute a full turn: messages in, response out
  async run(request: RunRequest): Promise<RunResponse>

  // Same but streaming
  async stream(request: RunRequest): ReadableStream
}
```

Internals:
- Creates a ToolLoopAgent with configured model + tools
- Injects memory files into system prompt before each run
- Uses `prepareStep` callback for compaction (check token count, summarize if over threshold)
- Returns all messages including tool call/result pairs

### Tools

Each tool is a Vercel AI SDK `tool()` with Zod schema.

**bash** (`tools/bash.ts`)
```typescript
tool({
  description: 'Execute a shell command',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().default(30000).describe('Timeout in ms'),
    workingDir: z.string().optional().describe('Working directory'),
  }),
  execute: async ({ command, timeout, workingDir }) => {
    // Use execa with timeout, return { stdout, stderr, exitCode }
  },
})
```

**file-read** (`tools/file-read.ts`)
```typescript
tool({
  description: 'Read a file, optionally with offset and line limit',
  inputSchema: z.object({
    path: z.string().describe('Absolute file path'),
    offset: z.number().optional().describe('Line number to start from (1-based)'),
    limit: z.number().optional().describe('Max lines to read'),
  }),
  execute: async ({ path, offset, limit }) => {
    // Read file, add line numbers, apply offset/limit
  },
})
```

**file-write** (`tools/file-write.ts`)
```typescript
tool({
  description: 'Write content to a file, creating directories if needed',
  inputSchema: z.object({
    path: z.string().describe('Absolute file path'),
    content: z.string().describe('File content to write'),
  }),
  execute: async ({ path, content }) => {
    // mkdir -p dirname, write file
  },
})
```

**file-edit** (`tools/file-edit.ts`)
```typescript
tool({
  description: 'Find and replace text in a file',
  inputSchema: z.object({
    path: z.string().describe('Absolute file path'),
    oldString: z.string().describe('Text to find'),
    newString: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().default(false),
  }),
  execute: async ({ path, oldString, newString, replaceAll }) => {
    // Read file, validate oldString exists (and is unique if !replaceAll), replace, write back
  },
})
```

### Tool Registry (`tools/index.ts`)

```typescript
const ALL_TOOLS = { bash: bashTool, 'file-read': fileReadTool, ... }

function getTools(names: string[]): Record<string, Tool> {
  // Return filtered subset of ALL_TOOLS matching requested names
  // Throw if unknown tool name requested
}
```

### Compaction (`compaction.ts`)

```typescript
function estimateTokens(messages: CoreMessage[]): number {
  // chars / 4 approximation (or use tiktoken for accuracy)
}

function shouldCompact(messages: CoreMessage[], threshold: number): boolean {
  return estimateTokens(messages) > threshold
}

async function compact(messages: CoreMessage[], model: LanguageModel): Promise<CoreMessage[]> {
  // Keep last N messages (e.g., last 20)
  // Summarize older messages via single LLM call
  // Return: [{ role: 'system', content: 'Summary: ...' }, ...recentMessages]
}
```

Integrated via Vercel AI SDK's `prepareStep`:
```typescript
prepareStep: async ({ messages }) => {
  if (shouldCompact(messages, TOKEN_THRESHOLD)) {
    return { messages: await compact(messages, model) }
  }
  return { messages }
}
```

### Memory (`memory.ts`)

```typescript
async function loadMemory(dir: string): Promise<string> {
  // Read all *.md files in dir
  // Format as: "## Memory\n\n### filename.md\n```\n<content>\n```\n\n..."
  // Return empty string if dir doesn't exist or is empty
}
```

Called by AgentRunner before each run, appended to systemPrompt.

### HTTP Server (`server.ts`)

Hono app:
```typescript
const app = new Hono()

app.post('/run', async (c) => {
  const request = await c.req.json<RunRequest>()
  const response = await runner.run(request)
  return c.json(response)
})

app.post('/run/stream', async (c) => {
  const request = await c.req.json<RunRequest>()
  const stream = await runner.stream(request)
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
})

app.get('/health', (c) => c.json({ ok: true, agentId: config.agentId }))
app.get('/tools', (c) => c.json({ tools: runner.getToolDefinitions() }))
```

### Configuration

Agent is configured via environment variables or constructor args (NOT YAML — that's orchestrator's job):

```typescript
interface AgentConfig {
  agentId: string
  port: number
  model: string              // e.g., "claude-sonnet-4-20250514"
  provider: string           // e.g., "anthropic"
  tools: string[]            // ["bash", "file-read", "file-write", "file-edit"]
  maxSteps: number           // default 20
  memoryDir?: string         // path to memory directory
  compactionThreshold: number // token threshold for compaction, default 100000
}
```

## Tasks (implementation order)

### T1.1: Scaffolding
- `package.json` with deps
- `tsconfig.json` extending base
- `vitest.config.ts`
- Basic build/dev/test scripts

### T1.2: Types (`types.ts`)
- RunRequest, RunResponse interfaces
- AgentConfig interface
- ToolDefinition type
- Re-export CoreMessage from `ai` package

### T1.3: bash tool + tests
### T1.4: file-read tool + tests
### T1.5: file-write tool + tests
### T1.6: file-edit tool + tests
### T1.7: Tool registry + tests
### T1.8: Memory loader + tests
### T1.9: Compaction engine + tests
### T1.10: AgentRunner + tests (mock LLM)
### T1.11: HTTP server + integration tests

## Testing Strategy

- **Mock LLM**: Vercel AI SDK supports mock providers for testing
- **Tool tests**: Use temp directories (vitest `beforeEach`/`afterEach`)
- **Server tests**: Use Hono's test client (`app.request()`)
- **No external deps needed**: Everything testable in isolation
