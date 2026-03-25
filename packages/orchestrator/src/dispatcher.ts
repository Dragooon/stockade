import type {
  AgentConfig,
  AgentsConfig,
  ChannelMessage,
  DispatchResult,
  PlatformConfig,
} from "./types.js";
import type { CanUseToolResult } from "./rbac.js";
import { checkAccess, buildPermissionHook } from "./rbac.js";

/**
 * Context needed for sub-agent dispatch — carries the full agent registry,
 * platform config, and the original caller's identity so RBAC applies
 * through the entire chain.
 */
export interface DispatchContext {
  allAgents: AgentsConfig;
  platform: PlatformConfig;
  /** Original caller's userId (for RBAC on sub-agents) */
  userId: string;
  /** Original caller's platform (for RBAC on sub-agents) */
  userPlatform: string;
}

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
  ) => Promise<CanUseToolResult>,
  context?: DispatchContext
): Promise<DispatchResult> {
  if (agentConfig.remote) {
    return dispatchRemote(agentConfig, message, sessionId);
  }
  return dispatchLocal(agentConfig, message, sessionId, permissionHook, context);
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
  ) => Promise<CanUseToolResult>,
  context?: DispatchContext
): Promise<DispatchResult> {
  // Dynamic import to allow mocking in tests
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let resultText = "";
  let resultSessionId = "";

  const allowedTools = [...agentConfig.tools];

  const options: Record<string, unknown> = {
    model: agentConfig.model,
    maxTurns: 20,
    permissionMode: "acceptEdits" as const,
  };

  // If agent has subagents and we have context, build the MCP server
  if (agentConfig.subagents?.length && context) {
    const mcpServer = await buildSubagentMcpServer(context);
    options.mcpServers = { orchestrator: mcpServer };
    allowedTools.push("mcp__orchestrator__ask_agent");
  }

  options.allowedTools = allowedTools;

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
 * Build an inline MCP server that exposes `ask_agent` for sub-agent delegation.
 * The tool reuses dispatch() with full RBAC applied to the original caller.
 */
async function buildSubagentMcpServer(context: DispatchContext) {
  const { tool, createSdkMcpServer } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const { z } = await import("zod");

  const askAgentTool = tool(
    "ask_agent",
    "Delegate a task to another agent. Returns the agent's response text.",
    {
      agentId: z.string().describe(
        "The ID of the agent to delegate to (must be defined in agents.yaml)"
      ),
      task: z.string().describe(
        "The task or question to send to the agent"
      ),
    },
    async (args: { agentId: string; task: string }) => {
      const targetConfig = context.allAgents.agents[args.agentId];
      if (!targetConfig) {
        return {
          content: [
            { type: "text" as const, text: `Unknown agent: ${args.agentId}` },
          ],
        };
      }

      // RBAC: check if the original user can access the target agent
      if (
        !checkAccess(
          context.userId,
          context.userPlatform,
          args.agentId,
          context.platform
        )
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Access denied: user cannot invoke agent "${args.agentId}"`,
            },
          ],
        };
      }

      // Build permission hook for the sub-agent (same user identity)
      const subPermissionHook = buildPermissionHook(
        context.userId,
        context.userPlatform,
        context.platform
      );

      // Build an ephemeral message for the sub-agent
      const subMessage: ChannelMessage = {
        scope: `subagent:${args.agentId}:${Date.now()}`,
        content: args.task,
        userId: context.userId,
        platform: context.userPlatform,
      };

      // Reuse dispatch() — handles local vs remote routing
      const result = await dispatch(
        args.agentId,
        subMessage,
        targetConfig,
        null, // ephemeral — no session resume
        subPermissionHook,
        context // pass context through for nested sub-agents
      );

      return {
        content: [{ type: "text" as const, text: result.result }],
      };
    }
  );

  return createSdkMcpServer({
    name: "orchestrator",
    version: "1.0.0",
    tools: [askAgentTool],
  });
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
