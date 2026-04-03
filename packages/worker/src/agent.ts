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
  };

  // Only set allowedTools when explicitly provided — omitting enables all tools
  if (request.tools) {
    options.allowedTools = request.tools;
  }

  console.log(
    `[worker] Starting agent query — session: ${request.sessionId ?? "new"}`
  );

  const startTime = Date.now();
  let turns = 0;
  let toolStart = 0;

  try {
    for await (const message of query({
      prompt: request.prompt,
      options: options as any,
    })) {
      if (message.session_id) sessionId = message.session_id;

      if (message.type === "assistant") {
        turns++;
        for (const block of (message as any).message?.content ?? []) {
          if (block.type === "tool_use") {
            toolStart = Date.now();
            console.log(`[worker] tool: ${block.name}`);
          }
        }
      } else if (message.type === "user" && toolStart) {
        console.log(`[worker] tool completed — ${Date.now() - toolStart}ms`);
        toolStart = 0;
      } else if ("result" in message) {
        result = (message as any).result;
        const usage = (message as any).usage;
        if (usage) {
          console.log(
            `[worker] llm: ${turns} turns — ${usage.input_tokens ?? "?"}in/${usage.output_tokens ?? "?"}out`
          );
        }
        console.log(
          `[worker] done — stop: ${(message as any).stop_reason ?? "unknown"}`
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Agent query failed: ${message}`);
    throw err;
  }

  console.log(`[worker] Agent query completed — ${Date.now() - startTime}ms`);
  return { result, sessionId };
}
