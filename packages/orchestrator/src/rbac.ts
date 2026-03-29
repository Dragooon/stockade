import { join } from "node:path";
import { homedir } from "node:os";
import type { PlatformConfig, ResolvedUser, AskApprovalFn } from "./types.js";
import { evaluateAgentPermissions, formatToolApproval, type PermissionContext } from "./permissions.js";

/**
 * Resolve a platform userId to a config user, their roles, and flattened permissions.
 * Returns null if no matching user is found.
 */
export function resolveUser(
  userId: string,
  platform: string,
  config: PlatformConfig
): ResolvedUser | null {
  for (const [username, userDef] of Object.entries(config.rbac.users)) {
    if (userDef.identities[platform] === userId) {
      const roles = userDef.roles;
      const permissions = roles.flatMap(
        (r) => config.rbac.roles[r]?.permissions ?? []
      );
      const deny = roles.flatMap(
        (r) => config.rbac.roles[r]?.deny ?? []
      );
      const allow = roles.flatMap(
        (r) => config.rbac.roles[r]?.allow ?? []
      );
      return { username, roles, permissions, deny, allow };
    }
  }
  return null;
}

/**
 * Check if a user (identified by platform userId) can access a given agent.
 * Unknown users are denied by default.
 */
export function checkAccess(
  userId: string,
  platform: string,
  agentId: string,
  config: PlatformConfig
): boolean {
  const user = resolveUser(userId, platform, config);
  if (!user) return false;

  return user.permissions.some(
    (p) => p === "agent:*" || p === `agent:${agentId}`
  );
}

/**
 * Match a tool rule pattern against a tool name and input.
 *
 * Supported patterns:
 * - "tool:*"           — all tools
 * - "tool:Bash"        — specific tool (all invocations)
 * - "tool:Bash:git *"  — tool + command glob (matches input.command)
 */
export function matchesToolRule(
  rule: string,
  tool: string,
  input: Record<string, unknown>
): boolean {
  if (!rule.startsWith("tool:")) return false;

  const parts = rule.split(":");
  // "tool:*"
  if (parts[1] === "*") return true;
  // "tool:Bash" — exact tool match (all invocations)
  if (parts.length === 2) return parts[1] === tool;
  // "tool:Bash:git*" — tool + pattern
  if (parts[1] !== tool) return false;

  const pattern = parts.slice(2).join(":");
  const command = String(input.command ?? input.content ?? "");

  // Convert glob pattern to regex: * → .*, ? → .
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(command);
}

/**
 * Agent SDK canUseTool return types.
 */
export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

/**
 * Build a permission hook function compatible with Agent SDK's canUseTool callback.
 *
 * Two-layer evaluation:
 *
 * **Layer 1 — User-level RBAC** (allow-by-default):
 *   1. All tools are allowed unless explicitly denied.
 *   2. `deny` rules block matching tool invocations.
 *   3. `allow` rules carve exceptions from deny rules (more specific wins).
 *
 * **Layer 2 — Agent-level permissions** (first-match-wins):
 *   Ordered rules from `agentConfig.permissions`. First matching rule wins.
 *   If no rule matches, implicit "ask" (HITL approval). If permissions is undefined, all allowed.
 *
 * Both layers must allow for the tool invocation to proceed.
 * Unknown users are denied everything (no agent access = no tool access).
 *
 * @param agentRules    Agent's permission rules (from agentConfig.permissions)
 * @param agentCwd      Agent's working directory (for resolving ./ paths in rules)
 * @param platformRoot  Platform root directory (for resolving / paths in rules).
 *                      Defaults to `~/.stockade`.
 * @param askApproval   Channel callback for HITL approval. When a tool invocation
 *                      matches an `ask` rule (or no rule matches), this function
 *                      is called to request human approval. If not provided,
 *                      "ask" resolves to "deny" (safe default).
 */
export function buildPermissionHook(
  userId: string,
  platform: string,
  config: PlatformConfig,
  agentRules?: string[],
  agentCwd?: string,
  platformRoot?: string,
  askApproval?: AskApprovalFn,
): (
  tool: string,
  input: Record<string, unknown>
) => Promise<CanUseToolResult> {
  const user = resolveUser(userId, platform, config);

  if (!user) {
    // Unknown user — deny everything
    return async (tool: string): Promise<CanUseToolResult> => ({
      behavior: "deny",
      message: `Permission denied: unknown user`,
    });
  }

  const { deny, allow } = user;

  // Build permission context for agent-level path resolution
  const home = homedir();
  const permCtx: PermissionContext | undefined =
    agentRules !== undefined
      ? {
          homeDir: home,
          agentCwd: agentCwd ?? process.cwd(),
          platformRoot: platformRoot ?? join(home, ".stockade"),
        }
      : undefined;

  return async (tool: string, input: Record<string, unknown>): Promise<CanUseToolResult> => {
    // ── Layer 1: User-level RBAC ──
    const denied = deny.some((rule) => matchesToolRule(rule, tool, input));

    if (denied) {
      const allowed = allow.some((rule) => matchesToolRule(rule, tool, input));
      if (!allowed) {
        return { behavior: "deny", message: `Denied by user policy: ${tool}` };
      }
    }

    // ── Layer 2: Agent-level permissions ──
    if (permCtx) {
      const agentResult = await evaluateAgentPermissions(
        agentRules,
        tool,
        input,
        permCtx,
      );
      if (agentResult === "deny") {
        return { behavior: "deny", message: `Denied by agent policy: ${tool}` };
      }
      if (agentResult === "ask") {
        if (askApproval) {
          const approved = await askApproval(tool, input);
          if (!approved) {
            return { behavior: "deny", message: `Denied by user (HITL): ${tool}` };
          }
          return { behavior: "allow", updatedInput: input };
        }
        // No callback — deny as safe default
        return { behavior: "deny", message: `Denied by agent policy (no HITL callback): ${tool}` };
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}

/**
 * PreToolUse hook output type — matches the SDK's PreToolUseHookSpecificOutput.
 */
export interface PreToolUseHookOutput {
  hookEventName: "PreToolUse";
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}

/**
 * Build a PreToolUse hook for the Agent SDK.
 *
 * Unlike `canUseTool` (which runs last in the permission chain and is skipped
 * when the SDK's built-in permission engine auto-approves), PreToolUse hooks
 * run FIRST — before deny rules, permission mode, and allow rules.
 *
 * This makes it the correct integration point for our RBAC: every tool
 * invocation passes through our two-layer permission system, regardless
 * of the SDK's built-in permission logic.
 *
 * The hook returns `permissionDecision: "allow"` or `"deny"`. For "ask" rules,
 * the hook calls the HITL approval callback and resolves to allow/deny based
 * on the user's response.
 */
export function buildPreToolUseHook(
  userId: string,
  platform: string,
  config: PlatformConfig,
  agentRules?: string[],
  agentCwd?: string,
  platformRoot?: string,
  askApproval?: AskApprovalFn,
): (input: { tool_name: string; tool_input: unknown }) => Promise<{
  hookSpecificOutput: PreToolUseHookOutput;
}> {
  const user = resolveUser(userId, platform, config);

  if (!user) {
    return async (input) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "Permission denied: unknown user",
      },
    });
  }

  const { deny, allow } = user;

  const home = homedir();
  const permCtx: PermissionContext | undefined =
    agentRules !== undefined
      ? {
          homeDir: home,
          agentCwd: agentCwd ?? process.cwd(),
          platformRoot: platformRoot ?? join(home, ".stockade"),
        }
      : undefined;

  return async (hookInput) => {
    const tool = hookInput.tool_name;
    const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;


    // ── Layer 1: User-level RBAC ──
    const denied = deny.some((rule) => matchesToolRule(rule, tool, input));

    if (denied) {
      const allowed = allow.some((rule) => matchesToolRule(rule, tool, input));
      if (!allowed) {

        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Denied by user policy: ${tool}`,
          },
        };
      }
    }

    // ── Layer 2: Agent-level permissions ──
    if (permCtx) {
      const agentResult = await evaluateAgentPermissions(
        agentRules,
        tool,
        input,
        permCtx,
      );
      if (agentResult === "deny") {

        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Denied by agent policy: ${tool}`,
          },
        };
      }
      if (agentResult === "ask") {
        if (askApproval) {
          const approved = await askApproval(tool, input);
          if (!approved) {

            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: `Denied by user (HITL): ${tool}`,
              },
            };
          }
        } else {
          // No HITL callback — deny as safe default

          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: `Denied by agent policy (no HITL callback): ${tool}`,
            },
          };
        }
      }
    }


    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        updatedInput: input,
      },
    };
  };
}
