import { query } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerRunRequest, WorkerRunResponse } from "./types.js";

const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
const DEFAULT_MODEL = "sonnet";
const DEFAULT_MAX_TURNS = 20;

export async function runAgent(request: WorkerRunRequest): Promise<WorkerRunResponse> {
  let sessionId = "";
  let result = "";

  for await (const message of query({
    prompt: request.prompt,
    options: {
      model: request.model ?? DEFAULT_MODEL,
      systemPrompt: request.systemPrompt,
      allowedTools: request.tools ?? DEFAULT_TOOLS,
      resume: request.sessionId ?? undefined,
      maxTurns: request.maxTurns ?? DEFAULT_MAX_TURNS,
    },
  })) {
    if (message.session_id) sessionId = message.session_id;
    if ("result" in message) result = (message as { result: string }).result;
  }

  return { result, sessionId };
}
