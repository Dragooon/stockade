import { z } from "zod";

export const WorkerRunRequestSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
});

export interface WorkerRunRequest {
  prompt: string;
  systemPrompt?: string;
  tools?: string[];
  model?: string;
  sessionId?: string;
  maxTurns?: number;
  effort?: "low" | "medium" | "high" | "max";
}

export interface WorkerRunResponse {
  result: string;
  sessionId: string;
}
