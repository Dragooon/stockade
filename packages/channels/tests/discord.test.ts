import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiscordAdapter } from '../src/discord/adapter.js'
import { OrchestratorClient } from '../src/orchestrator-client.js'

// Mock discord.js
vi.mock('discord.js', () => {
  const handlers: Record<string, Function> = {}
  const mockClient = {
    on: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler
      return mockClient
    }),
    once: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler
      return mockClient
    }),
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    user: { tag: 'TestBot#1234' },
    _handlers: handlers,
    _emit: (event: string, ...args: unknown[]) => {
      if (handlers[event]) handlers[event](...args)
    },
  }
  return {
    Client: vi.fn(() => mockClient),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMessageTyping: 8,
    },
    Events: {
      MessageCreate: 'messageCreate',
      ClientReady: 'ready',
      ThreadCreate: 'threadCreate',
      InteractionCreate: 'interactionCreate',
    },
    REST: vi.fn(),
    Routes: {
      applicationGuildCommands: vi.fn(),
    },
    ApplicationCommandOptionType: {
      String: 3,
    },
    SlashCommandBuilder: vi.fn(),
  }
})

vi.mock('../src/orchestrator-client.js', () => {
  return {
    OrchestratorClient: vi.fn().mockImplementation(() => ({
      sendMessage: vi.fn().mockResolvedValue({
        response: 'Agent says hi!',
        sessionId: 'sess-discord-1',
      }),
    })),
  }
})

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { bot: false, id: '999' },
    content: 'Hello bot',
    guild: { id: '111' },
    channel: {
      id: '222',
      isThread: () => false,
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeThreadMessage() {
  return makeMessage({
    channel: {
      id: '333',
      isThread: () => true,
      parentId: '222',
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
    },
  })
}

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter
  let mockClient: any
  let mockOrcClient: { sendMessage: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.clearAllMocks()

    adapter = new DiscordAdapter({
      token: 'test-token',
      orchestratorUrl: 'http://localhost:3000',
      bindings: [
        { server: '111', agent: 'test-agent', channels: '*' },
        { server: '222', agent: 'other-agent', channels: ['aaa', 'bbb'] },
      ],
    })

    // Grab the mocked client from discord.js
    const { Client } = await import('discord.js')
    mockClient = (Client as unknown as ReturnType<typeof vi.fn>).mock.results[
      (Client as unknown as ReturnType<typeof vi.fn>).mock.results.length - 1
    ].value

    // Grab the mocked orchestrator client
    const orcCalls = (OrchestratorClient as unknown as ReturnType<typeof vi.fn>).mock
      .results
    mockOrcClient = orcCalls[orcCalls.length - 1].value
  })

  it('has name "discord"', () => {
    expect(adapter.name).toBe('discord')
  })

  it('calls client.login on start', async () => {
    await adapter.start()
    expect(mockClient.login).toHaveBeenCalledWith('test-token')
  })

  it('calls client.destroy on stop', async () => {
    await adapter.start()
    await adapter.stop()
    expect(mockClient.destroy).toHaveBeenCalled()
  })

  it('ignores bot messages', async () => {
    await adapter.start()
    const msg = makeMessage({ author: { bot: true, id: '999' } })
    mockClient._emit('messageCreate', msg)

    expect(mockOrcClient.sendMessage).not.toHaveBeenCalled()
  })

  it('ignores messages from unbound servers', async () => {
    await adapter.start()
    const msg = makeMessage({ guild: { id: 'unknown-server' } })
    mockClient._emit('messageCreate', msg)

    expect(mockOrcClient.sendMessage).not.toHaveBeenCalled()
  })

  it('handles messages from wildcard-bound server', async () => {
    await adapter.start()
    const msg = makeMessage()
    mockClient._emit('messageCreate', msg)

    // Wait for async handler
    await vi.waitFor(() => {
      expect(mockOrcClient.sendMessage).toHaveBeenCalled()
    })

    const call = mockOrcClient.sendMessage.mock.calls[0][0]
    expect(call.scope).toBe('discord:111:222:999')
    expect(call.content).toBe('Hello bot')
    expect(call.platform).toBe('discord')
    expect(call.userId).toBe('999')
  })

  it('handles messages from specifically-bound channels', async () => {
    await adapter.start()
    const msg = makeMessage({
      guild: { id: '222' },
      channel: {
        id: 'aaa',
        isThread: () => false,
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      },
    })
    mockClient._emit('messageCreate', msg)

    await vi.waitFor(() => {
      expect(mockOrcClient.sendMessage).toHaveBeenCalled()
    })
  })

  it('ignores messages from non-bound channels in specific-channel binding', async () => {
    await adapter.start()
    const msg = makeMessage({
      guild: { id: '222' },
      channel: {
        id: 'not-bound',
        isThread: () => false,
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      },
    })
    mockClient._emit('messageCreate', msg)

    // Give async handler time to run (it shouldn't)
    await new Promise((r) => setTimeout(r, 50))
    expect(mockOrcClient.sendMessage).not.toHaveBeenCalled()
  })

  it('builds thread scope for thread messages', async () => {
    await adapter.start()
    const msg = makeThreadMessage()
    mockClient._emit('messageCreate', msg)

    await vi.waitFor(() => {
      expect(mockOrcClient.sendMessage).toHaveBeenCalled()
    })

    const call = mockOrcClient.sendMessage.mock.calls[0][0]
    expect(call.scope).toBe('discord:111:222:333:999')
  })

  it('sends typing indicator before calling orchestrator', async () => {
    await adapter.start()
    const msg = makeMessage()
    mockClient._emit('messageCreate', msg)

    await vi.waitFor(() => {
      expect(msg.channel.sendTyping).toHaveBeenCalled()
    })
  })

  it('replies with orchestrator response', async () => {
    await adapter.start()
    const msg = makeMessage()
    mockClient._emit('messageCreate', msg)

    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalledWith('Agent says hi!')
    })
  })

  it('splits long responses into multiple messages', async () => {
    const longResponse = 'x'.repeat(2500)
    mockOrcClient.sendMessage.mockResolvedValueOnce({
      response: longResponse,
      sessionId: 'sess-1',
    })

    await adapter.start()
    const msg = makeMessage()
    mockClient._emit('messageCreate', msg)

    await vi.waitFor(() => {
      // First chunk as reply, rest via channel.send
      expect(msg.reply).toHaveBeenCalled()
    })

    // The first 2000 chars go as reply, remaining 500 as channel.send
    const replyContent = msg.reply.mock.calls[0][0] as string
    expect(replyContent.length).toBeLessThanOrEqual(2000)
  })

  it('auto-joins new threads in bound channels', async () => {
    await adapter.start()
    const thread = {
      joinable: true,
      join: vi.fn().mockResolvedValue(undefined),
      guild: { id: '111' },
      parentId: '222',
    }
    mockClient._emit('threadCreate', thread)

    await vi.waitFor(() => {
      expect(thread.join).toHaveBeenCalled()
    })
  })

  it('does not auto-join threads in unbound channels', async () => {
    await adapter.start()
    const thread = {
      joinable: true,
      join: vi.fn().mockResolvedValue(undefined),
      guild: { id: 'unknown-server' },
      parentId: '222',
    }
    mockClient._emit('threadCreate', thread)

    // Give async handler time to run (it shouldn't join)
    await new Promise((r) => setTimeout(r, 50))
    expect(thread.join).not.toHaveBeenCalled()
  })

  it('registers interactionCreate handler on start', async () => {
    await adapter.start()
    expect(mockClient.on).toHaveBeenCalledWith(
      'interactionCreate',
      expect.any(Function),
    )
  })

  it('ignores DMs (no guild)', async () => {
    await adapter.start()
    const msg = makeMessage({ guild: null })
    mockClient._emit('messageCreate', msg)

    await new Promise((r) => setTimeout(r, 50))
    expect(mockOrcClient.sendMessage).not.toHaveBeenCalled()
  })
})
