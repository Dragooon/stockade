/** Redis channel naming helpers. */

export function msgChannel(scope: string): string {
  return `stockade:msg:${scope}`;
}

export function evtChannel(scope: string): string {
  return `stockade:evt:${scope}`;
}

export function ctlChannel(agentId: string): string {
  return `stockade:ctl:${agentId}`;
}

/** Worker → Orchestrator lifecycle channel (worker:ready, etc.) */
export function workerChannel(agentId: string): string {
  return `stockade:worker:${agentId}`;
}

/** psubscribe pattern for all worker events. */
export const EVT_PATTERN = "stockade:evt:*";

/** psubscribe pattern for all inbound messages. */
export const MSG_PATTERN = "stockade:msg:*";

/** psubscribe pattern for all worker lifecycle signals. */
export const WORKER_PATTERN = "stockade:worker:*";

/** Extract scope from a Redis channel name (e.g. "stockade:evt:discord:s:c" → "discord:s:c"). */
export function scopeFromChannel(channel: string): string {
  // Format: "stockade:{dir}:{scope}" where scope may itself contain colons.
  const second = channel.indexOf(":", channel.indexOf(":") + 1);
  return channel.slice(second + 1);
}
