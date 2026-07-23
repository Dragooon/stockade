import type { PlatformConfig } from "./types.js";

/** Result of resolving a scope: the handling agent plus any per-binding overrides. */
export interface ResolvedBinding {
  agentId: string;
  /** Per-binding model override (undefined → use the agent's default model). */
  model?: string;
  /** Per-binding effort override (undefined → use the agent's default effort). */
  effort?: "low" | "medium" | "high" | "max";
}

/**
 * Resolve a scope string to the agent that should handle it, plus any
 * per-binding model/effort overrides.
 *
 * For terminal scopes ("terminal:..."), uses platform.channels.terminal.agent.
 * For discord scopes ("discord:<server>:<channel>:..."), matches against bindings
 * in order — the FIRST matching binding wins, so channel-specific bindings must be
 * listed before a `channels: "*"` wildcard. Threads inherit their parent channel's
 * binding because the parent channel id sits at parts[2] for both direct messages
 * and thread messages.
 *
 * Throws if no matching binding is found.
 */
export function resolveBinding(
  scope: string,
  config: PlatformConfig
): ResolvedBinding {
  const parts = scope.split(":");
  const platform = parts[0];

  if (platform === "terminal") {
    const termConfig = config.channels.terminal;
    if (!termConfig) {
      throw new Error(`No terminal channel configured`);
    }
    return { agentId: termConfig.agent };
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
      const matched =
        channels === "*" ||
        (typeof channels === "string" && channels === channelId) ||
        (Array.isArray(channels) && channels.includes(channelId));
      if (matched) {
        return { agentId: binding.agent, model: binding.model, effort: binding.effort };
      }
    }

    throw new Error(
      `No binding found for discord scope: ${scope}`
    );
  }

  throw new Error(`Unknown platform in scope: ${platform}`);
}

/**
 * Resolve a scope string to the agent ID that should handle it.
 * Thin wrapper over {@link resolveBinding} for callers that only need the agent.
 */
export function resolveAgent(
  scope: string,
  config: PlatformConfig
): string {
  return resolveBinding(scope, config).agentId;
}
