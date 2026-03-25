import { ChannelRegistry } from './registry.js'
import type { ChannelStartupConfig } from './types.js'

const registry = new ChannelRegistry()

process.on('SIGINT', () => {
  registry.stop().then(() => process.exit(0))
})

process.on('SIGTERM', () => {
  registry.stop().then(() => process.exit(0))
})

// Build config from environment variables
const config: ChannelStartupConfig = {
  orchestratorUrl: process.env.ORCHESTRATOR_URL ?? 'http://localhost:3000',
  terminal: process.env.TERMINAL_ENABLED === 'true'
    ? {
        enabled: true,
        agent: process.env.TERMINAL_AGENT ?? 'default',
      }
    : undefined,
  discord: process.env.DISCORD_TOKEN
    ? {
        enabled: true,
        token: process.env.DISCORD_TOKEN,
        bindings: JSON.parse(process.env.DISCORD_BINDINGS ?? '[]'),
      }
    : undefined,
}

await registry.start(config)
