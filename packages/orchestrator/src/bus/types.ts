/**
 * Bus message and event types for Redis pub/sub dispatch.
 *
 * Orchestrator → Worker:  BusUserMessage  (stockade:msg:{scope})
 * Worker → Orchestrator:  BusWorkerEvent  (stockade:evt:{scope})
 * Orchestrator → Worker:  BusControlSignal (stockade:ctl:{agentId})
 */

import type { ChannelAttachment } from "../types.js";

// ── Orchestrator → Worker ─────────────────────────────────────────────────────

/** A user message published to a scope's message channel. */
export interface BusUserMessage {
  kind: "user_message";
  /** Unique ID correlating this message to its result event. */
  correlationId: string;
  scope: string;
  text: string;
  userId: string;
  userPlatform: string;
  attachments?: ChannelAttachment[];
  timestamp: string;
}

/** Control signal sent to a worker (keyed by agentId). */
export interface BusControlSignal {
  kind: "control";
  action: "shutdown" | "reset_session" | "abort";
  scope?: string;
  reason?: string;
  timestamp: string;
}

// ── Worker → Orchestrator ─────────────────────────────────────────────────────

export interface BusEventStarted {
  kind: "evt:started";
  scope: string;
  correlationId: string;
  sdkSessionId: string;
  timestamp: string;
}

export interface BusEventTurn {
  kind: "evt:turn";
  scope: string;
  correlationId: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  timestamp: string;
}

export interface BusEventToolStart {
  kind: "evt:tool_start";
  scope: string;
  correlationId: string;
  toolName: string;
  timestamp: string;
}

export interface BusEventToolEnd {
  kind: "evt:tool_end";
  scope: string;
  correlationId: string;
  toolName: string;
  elapsedMs: number;
  timestamp: string;
}

export interface BusEventResult {
  kind: "evt:result";
  scope: string;
  correlationId: string;
  text: string;
  sdkSessionId: string;
  stopReason: string;
  files?: Array<{ filename: string; contentType: string; path: string }>;
  timestamp: string;
}

export interface BusEventError {
  kind: "evt:error";
  scope: string;
  correlationId: string;
  message: string;
  timestamp: string;
}

export interface BusEventStaleSession {
  kind: "evt:stale_session";
  scope: string;
  correlationId: string;
  timestamp: string;
}

export type BusWorkerEvent =
  | BusEventStarted
  | BusEventTurn
  | BusEventToolStart
  | BusEventToolEnd
  | BusEventResult
  | BusEventError
  | BusEventStaleSession;

// ── Worker → Orchestrator lifecycle ──────────────────────────────────────────

/** Published to stockade:worker:{agentId} when the worker process starts. */
export interface BusWorkerLifecycle {
  kind: "worker:ready";
  agentId: string;
  timestamp: string;
}

/** Session info stored in Redis hashes. */
export interface BusSessionInfo {
  scope: string;
  agentId: string;
  callbackToken: string;
  workerUrl: string;
  sdkSessionId?: string;
  proxyToken?: string;
  createdAt: string;
  lastActivity: string;
  state: "active" | "idle" | "closed";
}
