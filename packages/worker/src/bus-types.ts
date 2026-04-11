/**
 * Worker-side Redis bus types.
 * Subset of the orchestrator's bus types — no dependency on orchestrator package.
 */

// ── Orchestrator → Worker ─────────────────────────────────────────────────────

export interface BusUserMessage {
  kind: "user_message";
  correlationId: string;
  scope: string;
  text: string;
  userId: string;
  userPlatform: string;
  timestamp: string;
}

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
  files?: Array<{ filename: string; contentType: string; path: string; content?: string }>;
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
