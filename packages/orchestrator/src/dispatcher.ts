import type {
  AgentConfig,
  ChannelMessage,
  DispatchResult,
} from "./types.js";
import type { CanUseToolResult } from "./rbac.js";

/**
 * Dispatch a message to an agent — either in-process via Agent SDK query(),
 * or via HTTP POST to a remote worker.
 */
export async function dispatch(
  agentId: string,
  message: ChannelMessage,
  agentConfig: AgentConfig,
  sessionId: string | null,
  permissionHook?: (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<CanUseToolResult>
): Promise<DispatchResult> {
  if (agentConfig.remote) {
    return dispatchRemote(agentConfig, message, sessionId);
  }
  return dispatchLocal(agentConfig, message, sessionId, permissionHook);
}

/**
 * In-process dispatch using Agent SDK query().
 */
async function dispatchLocal(
  agentConfig: AgentConfig,
  message: ChannelMessage,
  sessionId: string | null,
  permissionHook?: (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<CanUseToolResult>
): Promise<DispatchResult> {
  // Dynamic import to allow mocking in tests
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let resultText = "";
  let resultSessionId = "";

  const options: Record<string, unknown> = {
    model: agentConfig.model,
    allowedTools: agentConfig.tools,
    maxTurns: 20,
    permissionMode: "acceptEdits" as const,
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  if (agentConfig.system) {
    options.systemPrompt = agentConfig.system;
  }

  if (permissionHook) {
    options.canUseTool = permissionHook;
  }

  const stream = query({
    prompt: message.content,
    options: options as any,
  });

  for await (const msg of stream) {
    const m = msg as Record<string, unknown>;
    if (m.session_id) resultSessionId = String(m.session_id);
    if ("result" in m) resultText = String(m.result);
  }

  return { result: resultText, sessionId: resultSessionId };
}

/**
 * Remote dispatch via HTTP POST to a worker.
 */
async function dispatchRemote(
  agentConfig: AgentConfig,
  message: ChannelMessage,
  sessionId: string | null
): Promise<DispatchResult> {
  const baseUrl =
    agentConfig.url ?? `http://localhost:${agentConfig.port}`;
  const url = `${baseUrl}/run`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: message.content,
      systemPrompt: agentConfig.system,
      tools: agentConfig.tools,
      model: agentConfig.model,
      sessionId: sessionId ?? undefined,
      maxTurns: 20,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Worker responded with ${response.status}: ${await response.text()}`
    );
  }

  const data = (await response.json()) as {
    result: string;
    sessionId: string;
  };
  return { result: data.result, sessionId: data.sessionId };
}
