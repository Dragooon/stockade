/**
 * Join parts into a scope string. Throws if any part is empty.
 */
export function buildScope(parts: string[]): string {
  if (parts.length === 0) {
    throw new Error("Scope must have at least one part");
  }
  for (const part of parts) {
    if (part === "") {
      throw new Error("Scope parts must not be empty");
    }
  }
  return parts.join(":");
}

/**
 * Parse a scope string into platform + remaining parts.
 */
export function parseScope(scope: string): {
  platform: string;
  parts: string[];
} {
  const segments = scope.split(":");
  if (segments.length < 2) {
    throw new Error(`Invalid scope (need at least platform:id): ${scope}`);
  }
  const [platform, ...parts] = segments;
  return { platform, parts };
}

/**
 * Build a Discord channel scope: discord:<serverId>:<channelId>
 *
 * Sessions are channel-scoped (shared across all users in the channel).
 * The userId is carried separately in ChannelMessage for RBAC but is not
 * part of the session scope.
 */
export function discordScope(
  serverId: string,
  channelId: string
): string {
  return buildScope(["discord", serverId, channelId]);
}

/**
 * Build a Discord thread scope: discord:<serverId>:<channelId>:<threadId>
 *
 * Sessions are thread-scoped (shared across all users in the thread).
 */
export function discordThreadScope(
  serverId: string,
  channelId: string,
  threadId: string
): string {
  return buildScope(["discord", serverId, channelId, threadId]);
}

/**
 * Build a terminal scope: terminal:<sessionId>:<username>
 */
export function terminalScope(
  sessionId: string,
  username: string
): string {
  return buildScope(["terminal", sessionId, username]);
}
