import { join } from "node:path";
import type {
  AgentConfig,
  AgentsConfig,
  AskApprovalFn,
  ChannelAttachment,
  ChannelMessage,
  DispatchResult,
  PlatformConfig,
} from "./types.js";
import type { CanUseToolResult, PreToolUseHookOutput } from "./rbac.js";
import { checkAccess, buildPermissionHook, buildPreToolUseHook } from "./rbac.js";
import { resolveEffectivePermissions } from "./gatekeeper.js";
import type { ContainerManager } from "./containers/manager.js";

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
  /** Root directory for per-agent workspaces (data/agents/) */
  agentsDir?: string;
  /** Platform root directory (~/.stockade) — for `/` prefix in permission rules */
  platformRoot?: string;
  /** HITL approval callback — threaded from the originating channel so
   *  approval requests reach the user who sent the message. */
  askApproval?: AskApprovalFn;
  /** Container manager — threaded so sub-agent dispatch can start containers */
  containerManager?: ContainerManager;
  /** Credential proxy config — when set, both local and sandboxed agents
   *  can route through the proxy for credential injection. */
  proxy?: {
    gatewayUrl: string;
    host: string;
    caCertPath: string;
  };
}

/**
 * Dispatch a message to an agent — either in-process via Agent SDK query(),
 * or via HTTP POST to a sandboxed worker container.
 *
 * If a containerManager is provided and the agent is sandboxed, the manager
 * ensures a container is running before dispatching.
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
  context?: DispatchContext,
  containerManager?: ContainerManager
): Promise<DispatchResult> {
  if (agentConfig.sandboxed) {
    // If container manager is available, ensure a container is running
    if (containerManager) {
      const url = await containerManager.ensure(
        agentId,
        agentConfig,
        message.scope
      );
      return dispatchRemote({ ...agentConfig, url }, agentId, message, sessionId, context?.agentsDir);
    }
    return dispatchRemote(agentConfig, agentId, message, sessionId, context?.agentsDir);
  }
  return dispatchLocal(agentId, agentConfig, message, sessionId, permissionHook, context);
}

/**
 * Build platform-injected instructions based on the agent's runtime context.
 * These are operational docs the agent needs to function on the platform —
 * credential proxy usage, available env vars, etc. Kept separate from
 * user-authored system prompts and CLAUDE.md identity.
 */
function buildPlatformInstructions(
  agentConfig: AgentConfig,
  hasProxy: boolean,
): string {
  const sections: string[] = [];

  if (hasProxy && agentConfig.credentials?.length) {
    sections.push(`## Credential Proxy (platform-injected)

Your traffic is routed through the Stockade credential proxy. It handles API
key injection automatically — you never see raw credentials.

- **Header injection (automatic):** Outbound HTTPS requests to configured hosts
  have auth headers stripped and re-injected with the correct credential. API calls
  to Anthropic, Tavily, GitHub, etc. just work.

- **Body injection (ref tokens):** When a credential must appear in a request body,
  use the \`apw\` CLI:
  \`\`\`bash
  apw read <credential-key>
  # Returns: apw-ref:<key>:<nonce>
  \`\`\`
  Embed the ref string in your request body. The proxy substitutes it with the real
  value before forwarding. Ref tokens are one-time-use and expire after 5 minutes.

- **Your credential keys:** ${agentConfig.credentials.map(k => `\`${k}\``).join(", ")}

- **Available env vars:** HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS,
  APW_GATEWAY, APW_TOKEN`);
  }

  if (agentConfig.sandboxed) {
    sections.push(`## Network Policy (platform-injected)

You run in a sandboxed container. Only hosts in the proxy's network policy allowlist
are reachable. If a request is blocked, ask the parent agent if access is needed.`);
  }

  return sections.join("\n\n");
}

/**
 * Build the system prompt based on agent config and system_mode.
 *
 * Combines the user-authored system prompt (from config.yaml) with
 * platform-injected instructions (credential proxy, network policy, etc.).
 *
 * - "replace": returns combined prompt as a plain string (SDK replaces its default)
 * - "append": returns a preset object that keeps the SDK's Claude Code prompt and appends
 *
 * User identity and preferences live in CLAUDE.md in the agent's workspace directory,
 * loaded automatically by Claude Code via settingSources: ["project"].
 */
export function buildSystemPrompt(
  agentConfig: AgentConfig,
  hasProxy = false,
): string | { type: "preset"; preset: "claude_code"; append: string } | undefined {
  const platformInstructions = buildPlatformInstructions(agentConfig, hasProxy);
  const userSystem = agentConfig.system;

  // Combine user system prompt + platform instructions
  const combined = [userSystem, platformInstructions].filter(Boolean).join("\n\n");
  if (!combined) return undefined;

  const mode = agentConfig.system_mode ?? "replace";

  if (mode === "append") {
    return { type: "preset" as const, preset: "claude_code" as const, append: combined };
  }

  // replace mode — plain string
  return combined;
}

/**
 * Tools that must never be available to agents.
 * - Agent: bypasses our orchestration (RBAC, session, dispatch queue).
 *   Delegation must go through mcp__orchestrator__ask_agent.
 * - WebSearch: disabled platform-wide. Agents use Tavily via proxy instead.
 */
export const PLATFORM_DISALLOWED_TOOLS = ["Agent", "WebSearch"];

/**
 * Deny rules that prevent agents from modifying their own configuration.
 *
 * Since we set `settingSources: ["project"]`, Claude Code loads settings and
 * CLAUDE.md from the agent's cwd. If the agent writes to `.claude/` or
 * CLAUDE.md, those changes take effect on the next query() call — effectively
 * allowing the agent to rewrite its own permissions, hooks, instructions,
 * or MCP servers.
 *
 * These deny rules are injected at the highest-priority settings layer
 * and override even bypassPermissions mode.
 */
export const SELF_MODIFICATION_DENY_RULES = [
  // Block all writes to .claude/ — settings, MCP config, skills, agents, rules
  "Write(.claude/**)",
  "Edit(.claude/**)",
];

/**
 * Build the SDK `settings` object for an agent.
 * Controls memory, permissions, and prevents agents from modifying their
 * own configuration or instructions.
 */
export function buildSdkSettings(
  agentConfig: AgentConfig,
  agentId: string,
  agentsDir?: string
): Record<string, unknown> {
  const memoryDir = agentsDir
    ? join(agentsDir, agentId, "memory")
    : undefined;

  const memoryEnabled = agentConfig.memory?.enabled ?? true;

  return {
    autoMemoryEnabled: memoryEnabled,
    ...(memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
    autoDreamEnabled: agentConfig.memory?.autoDream ?? false,
    permissions: {
      deny: [
        // Prevent Agent tool (bypasses our orchestration)
        "Agent",
        // Prevent self-modification of settings, instructions, MCP config
        ...SELF_MODIFICATION_DENY_RULES,
      ],
    },
  };
}

/** Image MIME types the Anthropic API accepts as multimodal content blocks. */
const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

/**
 * Build a prompt from text + attachments for Agent SDK query().
 *
 * - Image attachments → base64 image content blocks via AsyncIterable<SDKUserMessage>
 * - Text attachments → inlined into the text content
 * - Returns plain string when there are no image attachments (fast path)
 */
function buildPromptWithAttachments(
  text: string,
  attachments: ChannelAttachment[],
  sessionId: string | null,
): string | AsyncIterable<{ type: "user"; message: unknown; parent_tool_use_id: null; session_id: string }> {
  const imageBlocks: unknown[] = [];
  const textParts: string[] = [];

  for (const att of attachments) {
    if (IMAGE_MIME_TYPES.has(att.contentType)) {
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: att.contentType,
          data: att.data,
        },
      });
    } else {
      // Text file — inline content
      textParts.push(`\n--- ${att.filename} ---\n${att.data}\n---`);
    }
  }

  // No images → just extend the string prompt (avoids AsyncIterable path)
  if (imageBlocks.length === 0) {
    return text + textParts.join("");
  }

  // Images present → wrap in AsyncIterable<SDKUserMessage>
  const content: unknown[] = [
    ...imageBlocks,
    { type: "text", text: text + textParts.join("") },
  ];

  const userMessage = {
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
    session_id: sessionId ?? "",
  };

  return (async function* () {
    yield userMessage;
  })();
}

/**
 * In-process dispatch using Agent SDK query().
 */
async function dispatchLocal(
  agentId: string,
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

  // Use `tools` to restrict which built-in tools are available to the agent.
  // NOTE: `allowedTools` auto-approves tools WITHOUT calling canUseTool — never use it.
  // Always strip Agent from explicit tool lists — delegation goes through ask_agent.
  const agentTools = agentConfig.tools
    ? agentConfig.tools.filter((t) => t !== "Agent")
    : undefined;

  const options: Record<string, unknown> = {
    model: agentConfig.model,
    maxTurns: 20,

    // ── Isolation: only load project-level settings/CLAUDE.md from agent cwd ──
    // Skips 'user' (no global settings bleed) and 'local' (no local overrides).
    settingSources: ["project"],

    // ── Permissions: PreToolUse hook is our sole gatekeeper ──
    // "acceptEdits" auto-approves file operations at the SDK level, but our
    // PreToolUse hook runs FIRST (step 1 in the permission chain) and handles
    // all allow/deny/ask decisions before the SDK's built-in logic.
    // This avoids interactive prompts that would hang in headless mode.
    permissionMode: "acceptEdits" as const,

    // ── Hard deny: Agent tool removed from model context entirely ──
    disallowedTools: PLATFORM_DISALLOWED_TOOLS,

    // ── Settings: inject memory config + deny Agent at settings level ──
    settings: buildSdkSettings(agentConfig, agentId, context?.agentsDir),
  };

  // Effort level
  if (agentConfig.effort) {
    options.effort = agentConfig.effort;
  }

  // Set agent's working directory
  if (context?.agentsDir) {
    options.cwd = join(context.agentsDir, agentId);
  }

  // If agent has subagents and we have context, build the MCP server
  if (agentConfig.subagents?.length && context) {
    const mcpServer = await buildSubagentMcpServer(context);
    options.mcpServers = { orchestrator: mcpServer };
    if (agentTools) {
      agentTools.push("mcp__orchestrator__ask_agent");
    }
  }

  // Use `tools` (not `allowedTools`) to restrict available tools.
  // `tools` controls availability; `canUseTool` controls permissions.
  if (agentTools) {
    options.tools = agentTools;
  }

  if (sessionId) {
    options.resume = sessionId;
  }

  // ── Credential proxy: route all agents with credentials through proxy ──
  // The proxy handles credential injection (Anthropic, Tavily, GitHub, etc.)
  // for both local and sandboxed agents. OAuth tokens use cache_ttl: 0 in
  // the proxy config to avoid serving stale tokens after CLI refresh.
  let proxyToken: string | undefined;
  if (context?.proxy && agentConfig.credentials?.length) {
    try {
      const tokenRes = await fetch(`${context.proxy.gatewayUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          agentId,
          credentials: agentConfig.credentials,
          storeKeys: agentConfig.store_keys,
        }),
      });
      if (tokenRes.ok) {
        const data = (await tokenRes.json()) as { token: string; expiresAt: number };
        proxyToken = data.token;
        options.env = {
          ...process.env,
          HTTP_PROXY: `http://${context.proxy.host}:10255`,
          HTTPS_PROXY: `http://${context.proxy.host}:10255`,
          NO_PROXY: "localhost,127.0.0.1",
          NODE_EXTRA_CA_CERTS: context.proxy.caCertPath,
          CURL_CA_BUNDLE: context.proxy.caCertPath,
          REQUESTS_CA_BUNDLE: context.proxy.caCertPath,
          SSL_CERT_FILE: context.proxy.caCertPath,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          APW_GATEWAY: context.proxy.gatewayUrl,
          APW_TOKEN: data.token,
          PYTHONIOENCODING: "utf-8",
        };

        // Resolve credential env vars for CLI tools (e.g. tavily CLI)
        // These map credential keys to the env vars that CLI tools expect.
        const credentialEnvMap: Record<string, string> = {
          "tavily-api-key": "TAVILY_API_KEY",
        };
        for (const credKey of agentConfig.credentials ?? []) {
          const envVar = credentialEnvMap[credKey];
          if (envVar && !options.env[envVar]) {
            try {
              const refRes = await fetch(
                `${context.proxy.gatewayUrl}/gateway/reveal/${credKey}`,
                {
                  headers: { Authorization: `Bearer ${data.token}` },
                  signal: AbortSignal.timeout(5000),
                },
              );
              if (refRes.ok) {
                const refData = (await refRes.json()) as { value: string };
                options.env[envVar] = refData.value;
              }
            } catch {
              // Non-fatal — CLI tool will fail but proxy injection still works
            }
          }
        }
      }
    } catch {
      // Proxy not running — continue without credential injection
    }
  }

  // Build system prompt with platform instructions (credential proxy docs, etc.)
  const systemPrompt = buildSystemPrompt(agentConfig, !!proxyToken);
  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }

  // ── PreToolUse hook: our RBAC runs at step 1 in the SDK permission chain ──
  // Unlike canUseTool (step 5, skipped when built-in logic auto-approves),
  // PreToolUse hooks run FIRST — every tool invocation passes through our RBAC.
  if (permissionHook) {
    options.hooks = {
      PreToolUse: [{
        hooks: [async (hookInput: Record<string, unknown>) => {
          const result = await permissionHook(
            String(hookInput.tool_name),
            (hookInput.tool_input ?? {}) as Record<string, unknown>,
          );
          // Translate canUseTool result → PreToolUse hook output
          if (result.behavior === "deny") {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: result.message ?? "Denied by RBAC",
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: result.updatedInput,
            },
          };
        }],
      }],
    };
  }

  // Build prompt — multimodal when image attachments are present
  const prompt = message.attachments?.length
    ? buildPromptWithAttachments(message.content, message.attachments, sessionId)
    : message.content;

  const stream = query({
    prompt: prompt as any,
    options: options as any,
  });

  try {
    for await (const msg of stream) {
      const m = msg as Record<string, unknown>;
      if (m.session_id) resultSessionId = String(m.session_id);
      if ("result" in m) resultText = String(m.result);
    }
  } finally {
    // Revoke proxy gateway token (best-effort)
    if (proxyToken && context?.proxy) {
      fetch(`${context.proxy.gatewayUrl}/token/${proxyToken}`, { method: "DELETE" }).catch(() => {});
    }
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

      // Build permission hook for the sub-agent (same user identity + target agent's rules)
      const subAgentCwd = context.agentsDir
        ? join(context.agentsDir, args.agentId)
        : undefined;
      const subEffectivePermissions = resolveEffectivePermissions(
        targetConfig.permissions,
        context.platform.gatekeeper,
      );
      const subPermissionHook = buildPermissionHook(
        context.userId,
        context.userPlatform,
        context.platform,
        subEffectivePermissions,
        subAgentCwd,
        context.platformRoot,
        context.askApproval,
      );

      // Build an ephemeral message for the sub-agent
      const subMessage: ChannelMessage = {
        scope: `subagent:${args.agentId}:${Date.now()}`,
        content: args.task,
        userId: context.userId,
        platform: context.userPlatform,
      };

      // Reuse dispatch() — handles local vs sandboxed routing
      const result = await dispatch(
        args.agentId,
        subMessage,
        targetConfig,
        null, // ephemeral — no session resume
        subPermissionHook,
        context, // pass context through for nested sub-agents
        context.containerManager // thread container manager for sandboxed sub-agents
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
 * Uses buildSystemPrompt() to honour system_mode.
 */
async function dispatchRemote(
  agentConfig: AgentConfig,
  _agentId: string,
  message: ChannelMessage,
  sessionId: string | null,
  _agentsDir?: string
): Promise<DispatchResult> {
  const baseUrl =
    agentConfig.url ?? `http://localhost:${agentConfig.port}`;
  const url = `${baseUrl}/run`;

  // Remote workers only accept string system prompts — flatten preset objects.
  // The worker's query() doesn't support the preset format, so always send raw text.
  // Sandboxed agents always go through proxy, so inject platform instructions.
  const builtPrompt = buildSystemPrompt(agentConfig, !!agentConfig.credentials?.length);
  const systemPrompt = typeof builtPrompt === "object" && builtPrompt !== null && builtPrompt !== undefined
    ? (builtPrompt as { append: string }).append
    : builtPrompt;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: message.content,
      systemPrompt: systemPrompt ?? agentConfig.system,
      tools: agentConfig.tools?.filter((t) => t !== "Agent"),
      model: agentConfig.model,
      sessionId: sessionId ?? undefined,
      maxTurns: 20,
      ...(agentConfig.effort ? { effort: agentConfig.effort } : {}),
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
