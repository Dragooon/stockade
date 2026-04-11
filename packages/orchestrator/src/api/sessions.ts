/**
 * Callback session registry — maps short-lived tokens to dispatch contexts.
 *
 * Each dispatch generates a UUID callback token. The token is sent to the
 * worker in POST /sessions so the worker can authenticate its callbacks
 * (PreToolUse, agent start/stop/message) back to the orchestrator.
 *
 * Tokens are created at the start of a dispatch and deleted when the
 * dispatch completes (result, error, or stale_session).
 */

import type { AgentConfig, AgentsConfig, AskApprovalFn, PlatformConfig } from "../types.js";

export interface CallbackSession {
  callbackToken: string;
  agentId: string;
  /** Channel scope this session was dispatched from (e.g. "discord:server:channel") */
  scope: string;
  userId: string;
  userPlatform: string;
  agentConfig: AgentConfig;
  /** Agent's cwd as seen inside the worker (host path or /workspace) */
  agentCwd: string;
  platformRoot: string;
  askApproval?: AskApprovalFn;
  platformConfig: PlatformConfig;
  allAgents: AgentsConfig;
  agentsDir: string;
  /** Set after POST /sessions returns the worker session ID */
  workerSessionId?: string;
  /** Worker base URL for this session */
  workerUrl?: string;
}

const registry = new Map<string, CallbackSession>();

export function createCallbackSession(token: string, ctx: CallbackSession): void {
  registry.set(token, ctx);
}

export function getCallbackSession(token: string): CallbackSession | undefined {
  return registry.get(token);
}

export function deleteCallbackSession(token: string): void {
  registry.delete(token);
}

export function updateCallbackSession(
  token: string,
  fields: Partial<Pick<CallbackSession, "userId" | "userPlatform" | "askApproval" | "workerSessionId" | "workerUrl">>,
): void {
  const session = registry.get(token);
  if (!session) return;
  if (fields.userId !== undefined) session.userId = fields.userId;
  if (fields.userPlatform !== undefined) session.userPlatform = fields.userPlatform;
  if (fields.askApproval !== undefined) session.askApproval = fields.askApproval;
  if (fields.workerSessionId !== undefined) session.workerSessionId = fields.workerSessionId;
  if (fields.workerUrl !== undefined) session.workerUrl = fields.workerUrl;
}
