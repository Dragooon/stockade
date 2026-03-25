# SPEC: Channels (`packages/channels`)

## Purpose

Platform adapters that receive messages from external sources and route them to the orchestrator. Each adapter translates platform-specific events into the unified ChannelMessage format and sends responses back. Knows nothing about agents, sessions, RBAC, or LLMs — those are orchestrator concerns.

## Dependencies

| Package | Purpose |
|---------|---------|
| `discord.js` | Discord bot client |
| `readline` | Terminal REPL (Node built-in) |
| `vitest` | Testing |

## File Structure

```
packages/channels/
├── src/
│   ├── index.ts                — ChannelRegistry, starts all enabled adapters
│   ├── types.ts                — ChannelMessage, ChannelAdapter interface
│   ├── orchestrator-client.ts  — HTTP client for orchestrator /api/message
│   ├── scope.ts                — Scope key builder/parser utilities
│   ├── terminal/
│   │   └── adapter.ts          — Terminal REPL adapter (stdin/stdout)
│   └── discord/
│       ├── adapter.ts          — Discord bot adapter (discord.js)
│       ├── commands.ts         — Slash command definitions + registration
│       └── scope.ts            — Discord-specific scope key builder
├── tests/
│   ├── scope.test.ts           — Scope key generation + parsing
│   ├── orchestrator-client.test.ts — HTTP client with mocked responses
│   ├── terminal.test.ts        — Terminal adapter with mock orchestrator
│   └── discord.test.ts         — Discord adapter with mock events + orchestrator
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Component Details

### Types (`types.ts`)

```typescript
interface ChannelMessage {
  scope: string              // "discord:123:456:789"
  content: string            // user message text
  userId: string             // platform user ID
  platform: string           // "discord" | "terminal"
  metadata?: Record<string, unknown>
}

interface ChannelAdapter {
  name: string               // "terminal" | "discord"
  start(): Promise<void>
  stop(): Promise<void>
}

interface OrchestratorResponse {
  response: string
  sessionId: string
}
```

### Scope Keys (`scope.ts`)

Scope keys uniquely identify a conversation context. Format:

```
discord:<server_id>:<channel_id>:<user_id>
discord:<server_id>:<channel_id>:<thread_id>:<user_id>    (forum threads)
terminal:local:<session_id>:<username>
```

```typescript
function buildScope(parts: string[]): string {
  // Join parts with ":", validate no empty segments
  return parts.join(':')
}

function parseScope(scope: string): { platform: string, parts: string[] } {
  const [platform, ...rest] = scope.split(':')
  return { platform, parts: rest }
}
```

### Orchestrator Client (`orchestrator-client.ts`)

HTTP client for posting messages to the orchestrator:

```typescript
class OrchestratorClient {
  constructor(baseUrl: string)  // e.g., "http://localhost:3000"

  async sendMessage(message: ChannelMessage): Promise<OrchestratorResponse> {
    // POST to ${baseUrl}/api/message
    // Handle timeout (default 120s — agent runs can be long)
    // Wrap errors with context
  }
}
```

### Terminal Adapter (`terminal/adapter.ts`)

Interactive REPL for local development and testing:

```typescript
class TerminalAdapter implements ChannelAdapter {
  name = 'terminal'

  constructor(config: { orchestratorUrl: string, agent: string })

  async start(): Promise<void> {
    // 1. Generate session UUID
    // 2. Get OS username
    // 3. Build scope: "terminal:local:<uuid>:<username>"
    // 4. Start readline interface
    // 5. On each line:
    //    - Build ChannelMessage { scope, content, userId: username, platform: 'terminal' }
    //    - POST to orchestrator
    //    - Print response to stdout
    // 6. Handle Ctrl+C gracefully
  }

  async stop(): Promise<void> {
    // Close readline interface
  }
}
```

Features:
- Single session per REPL instance (scope stays constant)
- Prints `> ` prompt for input
- Prints agent response with `\n` prefix for readability
- Shows `Thinking...` indicator while waiting for response
- Graceful shutdown on SIGINT

### Discord Adapter (`discord/adapter.ts`)

Full Discord bot with per-thread/channel session management:

```typescript
class DiscordAdapter implements ChannelAdapter {
  name = 'discord'

  constructor(config: {
    token: string
    orchestratorUrl: string
    bindings: Array<{
      server: string
      agent: string
      channels: string | string[]   // "*" or specific IDs
    }>
  })

  async start(): Promise<void> {
    // 1. Create discord.js Client with intents:
    //    - Guilds, GuildMessages, MessageContent, GuildMessageTyping
    // 2. Register event handlers:
    //    - messageCreate: handle incoming messages
    //    - threadCreate: handle new forum threads
    //    - ready: log bot online
    // 3. Login with token
  }

  async stop(): Promise<void> {
    // Destroy discord.js client
  }
}
```

Message handling flow:

```typescript
client.on('messageCreate', async (message) => {
  // 1. Ignore bot messages (message.author.bot)
  // 2. Ignore messages from servers not in bindings
  // 3. Check channel binding: does this server+channel have a binding?
  //    - Exact channel match OR wildcard "*"
  // 4. Build scope key:
  //    - Regular channel: "discord:<server>:<channel>:<user>"
  //    - Thread/forum:    "discord:<server>:<channel>:<thread>:<user>"
  // 5. Build ChannelMessage
  // 6. Show typing indicator (message.channel.sendTyping())
  // 7. POST to orchestrator
  // 8. Reply to message with response
  //    - If response > 2000 chars, split into multiple messages
  //    - Reply in thread if message is in a thread
})
```

Thread/forum handling:

```typescript
client.on('threadCreate', async (thread) => {
  // Auto-join new threads in bound channels
  // This ensures the bot sees messages in forum threads
  if (thread.joinable) await thread.join()
})
```

### Discord Slash Commands (`discord/commands.ts`)

```typescript
const commands = [
  {
    name: 'ask',
    description: 'Send a message to the agent',
    options: [{
      name: 'prompt',
      description: 'Your message',
      type: ApplicationCommandOptionType.String,
      required: true,
    }],
  },
  {
    name: 'new',
    description: 'Start a new conversation (creates a forum thread)',
    options: [{
      name: 'title',
      description: 'Thread title',
      type: ApplicationCommandOptionType.String,
      required: false,
    }],
  },
  {
    name: 'reset',
    description: 'Clear the current session history',
  },
]

async function registerCommands(client: Client, guildIds: string[]): Promise<void> {
  // Register slash commands for each guild in bindings
}
```

Slash command handling:

```typescript
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  switch (interaction.commandName) {
    case 'ask':
      // Defer reply, send message to orchestrator, edit reply with response
      break
    case 'new':
      // Create a new forum thread (if in a forum channel)
      // Or reply with instructions
      break
    case 'reset':
      // POST to orchestrator session delete endpoint
      // Confirm to user
      break
  }
})
```

### Channel Registry (`index.ts`)

```typescript
class ChannelRegistry {
  private adapters: ChannelAdapter[] = []

  async start(config: PlatformConfig): Promise<void> {
    // 1. Read channel configs from platform.yaml (passed in or loaded)
    // 2. For each enabled channel:
    //    - terminal: create TerminalAdapter
    //    - discord: create DiscordAdapter
    // 3. Start all adapters
  }

  async stop(): Promise<void> {
    // Stop all adapters (reverse order)
    // Used for graceful shutdown on SIGTERM/SIGINT
  }
}

// Entry point
const registry = new ChannelRegistry()

process.on('SIGINT', () => registry.stop())
process.on('SIGTERM', () => registry.stop())

await registry.start(config)
```

### Configuration

Channels are configured via the orchestrator's `platform.yaml` (not their own config). The channel package receives config at startup:

```typescript
// Loaded by the entry point or passed as CLI args / env vars
interface ChannelStartupConfig {
  orchestratorUrl: string    // "http://localhost:3000"
  terminal?: {
    enabled: boolean
    agent: string            // not used by channel directly, but passed in scope
  }
  discord?: {
    enabled: boolean
    token: string
    bindings: Array<{
      server: string
      agent: string
      channels: string | string[]
    }>
  }
}
```

The channel package can either:
1. Load `config/platform.yaml` directly (simple, duplicates config parsing)
2. Fetch config from orchestrator via a `/api/config/channels` endpoint
3. Receive config via environment variables or CLI args

**Recommended**: Load `config/platform.yaml` directly with a minimal YAML parser — channels only need the `channels` section, not RBAC.

## Tasks (implementation order)

### T3.1: Scaffolding
- Init `package.json` with deps (discord.js, vitest)
- `tsconfig.json` extending base
- `vitest.config.ts`
- Build/dev/test scripts
- Entry point (`src/index.ts`) with placeholder

### T3.2: Types (`types.ts`)
- ChannelMessage interface
- ChannelAdapter interface (name, start, stop)
- OrchestratorResponse interface
- ChannelStartupConfig type

### T3.3: Scope utilities (`scope.ts`) + tests
- `buildScope(parts)` → scope string
- `parseScope(scope)` → { platform, parts }
- Validation: no empty segments, minimum parts
- Tests: build, parse, roundtrip, edge cases (empty, single segment)

### T3.4: Orchestrator client (`orchestrator-client.ts`) + tests
- `OrchestratorClient` class with `sendMessage()`
- POST to `/api/message` with JSON body
- Timeout handling (120s default)
- Error wrapping with context (URL, status code, body)
- Tests: mock HTTP responses — success, timeout, 403, 500, network error

### T3.5: Terminal adapter (`terminal/adapter.ts`) + tests
- readline-based REPL
- Generates scope: `terminal:local:<uuid>:<username>`
- Single session per instance
- Reads input → sends to orchestrator → prints response
- Typing indicator (`Thinking...`)
- Graceful SIGINT handling
- Tests: mock stdin/stdout + mock orchestrator client, verify message format

### T3.6: Discord adapter (`discord/adapter.ts`) + tests
- discord.js Client with required intents
- Message handler: ignore bots, check bindings, build scope, send to orchestrator, reply
- Thread handling: auto-join, thread scope keys
- Message splitting for >2000 char responses
- Typing indicator while waiting
- Tests: mock discord.js Client + events, mock orchestrator client, verify scope generation

### T3.7: Discord slash commands (`discord/commands.ts`) + tests
- Command definitions: `/ask`, `/new`, `/reset`
- Command registration per guild
- Interaction handler: defer reply, call orchestrator, edit reply
- Tests: mock interactions, verify orchestrator calls

### T3.8: Channel registry (`index.ts`) + tests
- Load config (platform.yaml channels section)
- Instantiate and start enabled adapters
- Graceful shutdown (SIGTERM, SIGINT → stop all)
- Tests: start/stop lifecycle, only enabled adapters started

## Testing Strategy

- **Unit tests**: Each module tested in isolation with mocked dependencies
- **Mock discord.js**: Use mock Client, mock Message, mock Interaction objects
- **Mock orchestrator**: Mock HTTP responses from orchestrator API
- **No real Discord connection**: All Discord tests use mocked events
- **Terminal tests**: Mock readline interface for input simulation
- **Scope tests**: Pure function tests, no mocks needed
