/**
 * Build a scope key from parts.
 * Scope keys uniquely identify a conversation context.
 *
 * Format examples:
 *   discord:<server_id>:<channel_id>:<user_id>
 *   terminal:local:<session_id>:<username>
 */
export function buildScope(parts: string[]): string {
  if (parts.length < 2) {
    throw new Error(
      `Scope must have at least 2 parts (platform + identifier), got ${parts.length}`,
    )
  }
  for (const part of parts) {
    if (part === '') {
      throw new Error('Scope parts must not contain empty segments')
    }
    if (part.includes(':')) {
      throw new Error(`Scope parts must not contain colons, got "${part}"`)
    }
  }
  return parts.join(':')
}

/**
 * Parse a scope key string into its platform and remaining parts.
 */
export function parseScope(scope: string): { platform: string; parts: string[] } {
  if (!scope) {
    throw new Error('Scope string must not be empty')
  }
  const [platform, ...rest] = scope.split(':')
  if (rest.length === 0) {
    throw new Error(
      `Scope must have at least a platform and one additional part, got "${scope}"`,
    )
  }
  return { platform, parts: rest }
}
