import { buildScope } from '../scope.js'

/**
 * Build a Discord scope key for a regular channel message.
 */
export function buildDiscordScope(
  serverId: string,
  channelId: string,
  userId: string,
): string {
  return buildScope(['discord', serverId, channelId, userId])
}

/**
 * Build a Discord scope key for a thread/forum message.
 */
export function buildDiscordThreadScope(
  serverId: string,
  parentChannelId: string,
  threadId: string,
  userId: string,
): string {
  return buildScope(['discord', serverId, parentChannelId, threadId, userId])
}
