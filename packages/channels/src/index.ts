export { ChannelRegistry } from './registry.js'
export { OrchestratorClient } from './orchestrator-client.js'
export { buildScope, parseScope } from './scope.js'
export { TerminalAdapter } from './terminal/adapter.js'
export { DiscordAdapter } from './discord/adapter.js'
export {
  commandDefinitions,
  registerCommands,
  handleInteraction,
} from './discord/commands.js'
export type {
  ChannelMessage,
  ChannelAdapter,
  OrchestratorResponse,
  ChannelStartupConfig,
} from './types.js'
