import { query } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerRunRequest, WorkerRunResponse } from "./types.js";

const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TURNS = 20;

export async function runAgent(request: WorkerRunRequest): Promise<WorkerRunResponse> {
  let sessionId = "";
  let result = "";

  const options: Record<string, unknown> = {
    model: request.model ?? DEFAULT_MODEL,
    systemPrompt: request.systemPrompt,
    resume: request.sessionId ?? undefined,
    maxTurns: request.maxTurns ?? DEFAULT_MAX_TURNS,
    cwd: process.env.AGENT_WORKSPACE ?? process.cwd(),

    // Load CLAUDE.md and .claude/ settings from the agent's workspace.
    // Without this, the SDK skips project-level instructions.
    settingSources: ["project"],

    // Accept file edits without interactive prompts (headless mode).
    permissionMode: "acceptEdits",
  };

  if (request.effort) {
    options.effort = request.effort;
  }

  // Only set allowedTools when explicitly provided — omitting enables all tools
  if (request.tools) {
    options.allowedTools = request.tools;
  }

  for await (const message of query({
    prompt: request.prompt,
    options: options as any,
  })) {
    if (message.session_id) sessionId = message.session_id;
    if ("result" in message) result = (message as { result: string }).result;
  }

  return { result, sessionId };
}
