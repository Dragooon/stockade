import type { PlatformConfig } from '@/types';

export interface ParsedScope {
  platform: string;
  server?: string;
  channel?: string;
  user?: string;
}

/** Parse a scope string into its components.
 * Format: "platform:server:channel:user" (discord) or "platform:user" (terminal)
 */
export function parseScope(scope: string): ParsedScope {
  const parts = scope.split(':');
  const platform = parts[0];

  if (platform === 'discord') {
    return {
      platform,
      server: parts[1],
      channel: parts[2],
      user: parts[3],
    };
  }

  // terminal and others: "platform:user"
  return {
    platform,
    user: parts[1],
  };
}

/** Resolve a scope to an agent ID using platform config bindings */
export function resolveAgent(scope: string, config: PlatformConfig): string {
  const parsed = parseScope(scope);

  if (parsed.platform === 'terminal') {
    const terminalConfig = config.channels.terminal;
    if (!terminalConfig || !terminalConfig.enabled) {
      throw new Error(`Terminal channel is not configured or not enabled`);
    }
    return terminalConfig.agent;
  }

  if (parsed.platform === 'discord') {
    const discordConfig = config.channels.discord;
    if (!discordConfig || !discordConfig.enabled) {
      throw new Error(`Discord channel is not configured or not enabled`);
    }

    for (const binding of discordConfig.bindings) {
      if (binding.server !== parsed.server) continue;

      // Check channel match
      if (binding.channels === '*') {
        return binding.agent;
      }

      const channelList = Array.isArray(binding.channels)
        ? binding.channels
        : [binding.channels];

      if (parsed.channel && channelList.includes(parsed.channel)) {
        return binding.agent;
      }
    }

    throw new Error(`No binding matches scope "${scope}"`);
  }

  throw new Error(`Unsupported platform: ${parsed.platform}`);
}
