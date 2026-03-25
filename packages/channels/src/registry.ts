import type { ChannelAdapter, ChannelStartupConfig } from './types.js'
import { TerminalAdapter } from './terminal/adapter.js'
import { DiscordAdapter } from './discord/adapter.js'

export class ChannelRegistry {
  private adapters: ChannelAdapter[] = []

  async start(config: ChannelStartupConfig): Promise<void> {
    // Create terminal adapter if enabled
    if (config.terminal?.enabled) {
      const terminal = new TerminalAdapter({
        orchestratorUrl: config.orchestratorUrl,
        agent: config.terminal.agent,
      })
      this.adapters.push(terminal)
    }

    // Create discord adapter if enabled
    if (config.discord?.enabled) {
      const discord = new DiscordAdapter({
        token: config.discord.token,
        orchestratorUrl: config.orchestratorUrl,
        bindings: config.discord.bindings,
      })
      this.adapters.push(discord)
    }

    // Start all adapters
    for (const adapter of this.adapters) {
      await adapter.start()
      console.log(`Channel adapter "${adapter.name}" started`)
    }
  }

  async stop(): Promise<void> {
    // Stop in reverse order
    const toStop = [...this.adapters].reverse()
    for (const adapter of toStop) {
      try {
        await adapter.stop()
        console.log(`Channel adapter "${adapter.name}" stopped`)
      } catch (err) {
        const error = err as Error
        console.error(
          `Error stopping adapter "${adapter.name}": ${error.message}`,
        )
      }
    }
    this.adapters = []
  }

  getAdapters(): ChannelAdapter[] {
    return [...this.adapters]
  }
}
