import type { PlatformConfig, ResolvedUser } from "./types.js";

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
      return { username, roles, permissions };
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
 * Match a permission pattern like "tool:Bash:git*" against a tool name and input.
 *
 * Supported patterns:
 * - "tool:*"           — all tools
 * - "tool:Bash"        — specific tool
 * - "tool:Bash:git*"   — tool + command prefix pattern (matches input.command)
 */
function matchesToolPattern(
  permission: string,
  tool: string,
  input: Record<string, unknown>
): boolean {
  if (!permission.startsWith("tool:")) return false;

  const parts = permission.split(":");
  // "tool:*"
  if (parts[1] === "*") return true;
  // "tool:Bash" — exact tool match
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
 * Returns an async function matching the SDK's (toolName, input) => CanUseToolResult signature.
 */
export function buildPermissionHook(
  userId: string,
  platform: string,
  config: PlatformConfig
): (
  tool: string,
  input: Record<string, unknown>
) => Promise<CanUseToolResult> {
  const user = resolveUser(userId, platform, config);
  const permissions = user?.permissions ?? [];

  return async (tool: string, input: Record<string, unknown>): Promise<CanUseToolResult> => {
    // Check wildcard
    if (permissions.includes("tool:*")) return { behavior: "allow", updatedInput: input };

    // Check exact tool match
    if (permissions.includes(`tool:${tool}`)) return { behavior: "allow", updatedInput: input };

    // Check pattern-based permissions
    for (const perm of permissions) {
      if (matchesToolPattern(perm, tool, input)) return { behavior: "allow", updatedInput: input };
    }

    return { behavior: "deny", message: `Permission denied: ${tool}` };
  };
}
