import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  commandDefinitions,
  handleInteraction,
  registerCommands,
} from '../src/discord/commands.js'
import { OrchestratorClient } from '../src/orchestrator-client.js'

vi.mock('../src/orchestrator-client.js', () => {
  return {
    OrchestratorClient: vi.fn().mockImplementation(() => ({
      sendMessage: vi.fn().mockResolvedValue({
        response: 'Command response!',
        sessionId: 'sess-cmd-1',
      }),
    })),
  }
})

vi.mock('discord.js', () => {
  return {
    REST: vi.fn().mockImplementation(() => ({
      setToken: vi.fn().mockReturnThis(),
      put: vi.fn().mockResolvedValue(undefined),
    })),
    Routes: {
      applicationGuildCommands: vi.fn(
        (appId: string, guildId: string) =>
          `/applications/${appId}/guilds/${guildId}/commands`,
      ),
    },
    ApplicationCommandOptionType: {
      String: 3,
    },
    SlashCommandBuilder: vi.fn(),
    Client: vi.fn(),
    GatewayIntentBits: {},
    Events: {},
  }
})

function makeInteraction(commandName: string, options: Record<string, string> = {}) {
  return {
    isChatInputCommand: () => true,
    commandName,
    guild: { id: '111' },
    channel: {
      id: '222',
      isThread: () => false,
    },
    user: { id: '999' },
    options: {
      getString: vi.fn((name: string) => options[name] ?? null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  }
}

describe('commandDefinitions', () => {
  it('defines /ask command', () => {
    const ask = commandDefinitions.find((c) => c.name === 'ask')
    expect(ask).toBeDefined()
    expect(ask!.description).toBeTruthy()
    expect(ask!.options).toHaveLength(1)
    expect(ask!.options![0].name).toBe('prompt')
    expect(ask!.options![0].required).toBe(true)
  })

  it('defines /new command', () => {
    const cmd = commandDefinitions.find((c) => c.name === 'new')
    expect(cmd).toBeDefined()
    expect(cmd!.options).toHaveLength(1)
    expect(cmd!.options![0].required).toBe(false)
  })

  it('defines /reset command', () => {
    const cmd = commandDefinitions.find((c) => c.name === 'reset')
    expect(cmd).toBeDefined()
  })
})

describe('handleInteraction', () => {
  let mockOrcClient: { sendMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    const orcCalls = (OrchestratorClient as unknown as ReturnType<typeof vi.fn>).mock
      .results
    // Create a fresh instance for testing
    const freshClient = new OrchestratorClient('http://localhost:3000')
    const latestCalls = (OrchestratorClient as unknown as ReturnType<typeof vi.fn>)
      .mock.results
    mockOrcClient = latestCalls[latestCalls.length - 1].value
  })

  it('handles /ask command: defers, sends to orchestrator, edits reply', async () => {
    const interaction = makeInteraction('ask', { prompt: 'Hello agent' })

    const bindings = [{ server: '111', agent: 'test-agent', channels: '*' as string | string[] }]
    await handleInteraction(
      interaction as any,
      new OrchestratorClient('http://localhost:3000'),
      bindings,
    )

    // Get the actual mock client used
    const orcResults = (OrchestratorClient as unknown as ReturnType<typeof vi.fn>)
      .mock.results
    const usedClient = orcResults[orcResults.length - 1].value

    expect(interaction.deferReply).toHaveBeenCalled()
    expect(usedClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Hello agent',
        platform: 'discord',
        userId: '999',
      }),
    )
    expect(interaction.editReply).toHaveBeenCalledWith('Command response!')
  })

  it('handles /ask with no prompt gracefully', async () => {
    const interaction = makeInteraction('ask', {})

    const bindings = [{ server: '111', agent: 'test-agent', channels: '*' as string | string[] }]
    await handleInteraction(
      interaction as any,
      new OrchestratorClient('http://localhost:3000'),
      bindings,
    )

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    )
  })

  it('handles /new command', async () => {
    const interaction = makeInteraction('new', { title: 'My Thread' })

    const bindings = [{ server: '111', agent: 'test-agent', channels: '*' as string | string[] }]
    await handleInteraction(
      interaction as any,
      new OrchestratorClient('http://localhost:3000'),
      bindings,
    )

    expect(interaction.reply).toHaveBeenCalled()
  })

  it('handles /reset command', async () => {
    const interaction = makeInteraction('reset')

    const bindings = [{ server: '111', agent: 'test-agent', channels: '*' as string | string[] }]
    await handleInteraction(
      interaction as any,
      new OrchestratorClient('http://localhost:3000'),
      bindings,
    )

    expect(interaction.reply).toHaveBeenCalled()
  })

  it('ignores non-chat-input interactions', async () => {
    const interaction = {
      isChatInputCommand: () => false,
    }

    const bindings = [{ server: '111', agent: 'test-agent', channels: '*' as string | string[] }]
    await handleInteraction(
      interaction as any,
      new OrchestratorClient('http://localhost:3000'),
      bindings,
    )

    // No errors thrown, just early return
  })
})

describe('registerCommands', () => {
  it('registers commands for each guild', async () => {
    const { REST } = await import('discord.js')
    await registerCommands('test-token', 'app-123', ['guild-1', 'guild-2'])

    const restInstance = (REST as unknown as ReturnType<typeof vi.fn>).mock
      .results[0].value
    expect(restInstance.setToken).toHaveBeenCalledWith('test-token')
    expect(restInstance.put).toHaveBeenCalledTimes(2)
  })
})
