import type { PlatformConfig } from "./types.js";

/**
 * Resolve a scope string to the agent ID that should handle it.
 *
 * For terminal scopes ("terminal:..."), uses platform.channels.terminal.agent.
 * For discord scopes ("discord:<server>:<channel>:..."), matches against bindings.
 *
 * Throws if no matching binding is found.
 */
export function resolveAgent(
  scope: string,
  config: PlatformConfig
): string {
  const parts = scope.split(":");
  const platform = parts[0];

  if (platform === "terminal") {
    const termConfig = config.channels.terminal;
    if (!termConfig) {
      throw new Error(`No terminal channel configured`);
    }
    return termConfig.agent;
  }

  if (platform === "discord") {
    const discordConfig = config.channels.discord;
    if (!discordConfig) {
      throw new Error(`No discord channel configured`);
    }

    const serverId = parts[1];
    const channelId = parts[2];

    for (const binding of discordConfig.bindings) {
      if (binding.server !== serverId) continue;

      const channels = binding.channels;
      if (channels === "*") return binding.agent;
      if (typeof channels === "string" && channels === channelId)
        return binding.agent;
      if (Array.isArray(channels) && channels.includes(channelId))
        return binding.agent;
    }

    throw new Error(
      `No binding found for discord scope: ${scope}`
    );
  }

  throw new Error(`Unknown platform in scope: ${platform}`);
}
