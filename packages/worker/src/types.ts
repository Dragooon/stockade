import { z } from "zod";

const sdkPresetSchema = z.object({
  type: z.literal("preset"),
  preset: z.literal("claude_code"),
  append: z.string(),
});

export const WorkerSessionRequestSchema = z.object({
  // prompt is optional in Redis mode (messages arrive via pub/sub)
  prompt: z.string().optional().default(""),
  systemPrompt: z.union([z.string(), sdkPresetSchema]).optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  forceNewSession: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
  effort: z.string().optional(),
  scope: z.string().optional(),
  // Unified dispatch additions:
  cwd: z.string().optional(),
  addDir: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  orchestratorUrl: z.string(),
  callbackToken: z.string(),
  sdkSettings: z.record(z.string(), z.unknown()).optional(),
  /** When true: subscribe to Redis for messages, publish events to Redis. */
  redisMode: z.boolean().optional(),
});

export interface WorkerSessionRequest {
  prompt: string;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append: string };
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  sessionId?: string;
  forceNewSession?: boolean;
  maxTurns?: number;
  effort?: string;
  scope?: string;
  cwd?: string;
  addDir?: string[];
  env?: Record<string, string>;
  orchestratorUrl: string;
  callbackToken: string;
  sdkSettings?: Record<string, unknown>;
  /** When true: subscribe to Redis for messages, publish events to Redis. */
  redisMode?: boolean;
}

export type WorkerEvent =
  | { type: "started"; sessionId: string }
  | { type: "turn"; turns: number; input: number; output: number; cacheRead: number; cacheCreate: number }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; elapsedMs: number }
  | { type: "result"; text: string; sessionId: string; stopReason: string; files?: Array<{ filename: string; contentType: string; path: string; content?: string }> }
  | { type: "error"; message: string }
  | { type: "stale_session" };

export interface WorkerRunResponse {
  result: string;
  sessionId: string;
}
