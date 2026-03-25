import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChannelRegistry } from '../src/registry.js'
import type { ChannelAdapter, ChannelStartupConfig } from '../src/types.js'

// Mock the adapters
vi.mock('../src/terminal/adapter.js', () => {
  return {
    TerminalAdapter: vi.fn().mockImplementation(() => ({
      name: 'terminal',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

vi.mock('../src/discord/adapter.js', () => {
  return {
    DiscordAdapter: vi.fn().mockImplementation(() => ({
      name: 'discord',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

describe('ChannelRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts only terminal when only terminal is enabled', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      terminal: { enabled: true, agent: 'test-agent' },
    }

    await registry.start(config)

    const adapters = registry.getAdapters()
    expect(adapters).toHaveLength(1)
    expect(adapters[0].name).toBe('terminal')
    expect(adapters[0].start).toHaveBeenCalled()
  })

  it('starts only discord when only discord is enabled', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      discord: {
        enabled: true,
        token: 'test-token',
        bindings: [{ server: '111', agent: 'test-agent', channels: '*' }],
      },
    }

    await registry.start(config)

    const adapters = registry.getAdapters()
    expect(adapters).toHaveLength(1)
    expect(adapters[0].name).toBe('discord')
    expect(adapters[0].start).toHaveBeenCalled()
  })

  it('starts both adapters when both enabled', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      terminal: { enabled: true, agent: 'test-agent' },
      discord: {
        enabled: true,
        token: 'test-token',
        bindings: [{ server: '111', agent: 'test-agent', channels: '*' }],
      },
    }

    await registry.start(config)

    const adapters = registry.getAdapters()
    expect(adapters).toHaveLength(2)
    expect(adapters.map((a) => a.name).sort()).toEqual(['discord', 'terminal'])
  })

  it('starts no adapters when none enabled', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      terminal: { enabled: false, agent: 'test-agent' },
      discord: {
        enabled: false,
        token: 'test-token',
        bindings: [],
      },
    }

    await registry.start(config)

    const adapters = registry.getAdapters()
    expect(adapters).toHaveLength(0)
  })

  it('starts no adapters when config sections are missing', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
    }

    await registry.start(config)

    const adapters = registry.getAdapters()
    expect(adapters).toHaveLength(0)
  })

  it('stops all adapters in reverse order', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      terminal: { enabled: true, agent: 'test-agent' },
      discord: {
        enabled: true,
        token: 'test-token',
        bindings: [{ server: '111', agent: 'test-agent', channels: '*' }],
      },
    }

    await registry.start(config)
    const adapters = registry.getAdapters()

    const stopOrder: string[] = []
    for (const adapter of adapters) {
      const origStop = adapter.stop;
      (adapter.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        stopOrder.push(adapter.name)
      })
    }

    await registry.stop()

    // Should be reversed (discord started after terminal, so stopped first)
    expect(stopOrder[0]).toBe('discord')
    expect(stopOrder[1]).toBe('terminal')
  })

  it('stop is idempotent (can call stop multiple times)', async () => {
    const registry = new ChannelRegistry()
    const config: ChannelStartupConfig = {
      orchestratorUrl: 'http://localhost:3000',
      terminal: { enabled: true, agent: 'test-agent' },
    }

    await registry.start(config)
    await registry.stop()
    await registry.stop() // Should not throw
  })
})
