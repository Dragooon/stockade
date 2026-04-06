/**
 * Agent-level permission engine.
 *
 * Evaluates ordered first-match-wins rules defined per-agent in config.yaml.
 * Each rule is `allow:Selector`, `deny:Selector`, or `ask:Selector`.
 *
 * Selector formats:
 *   - `*`                    — matches all tools
 *   - `ToolName`             — matches specific tool (all invocations)
 *   - `ToolName(pattern)`    — matches tool with path/command glob
 *
 * Path prefix conventions (aligned with Claude Code):
 *   - `//`    — absolute POSIX path (Windows: `//c/Users/...`, Unix: `//home/...`)
 *   - `~/`    — home directory
 *   - `/`     — platform root (`~/.stockade`)
 *   - `./`    — agent working directory
 *   - bare    — agent working directory (same as `./`)
 *
 * All paths are normalized to POSIX form internally:
 *   - Windows `C:\Users\mail` → `/c/Users/mail`
 *   - Backslashes → forward slashes
 *   - Case-insensitive matching on Windows
 *
 * Path security:
 *   - `..` segments are normalized out
 *   - Symlinks are resolved to canonical paths
 *
 * For Bash, the pattern is a glob matched against the `command` input.
 *
 * If no rule matches, the default is **ask** (HITL approval required).
 * If the agent has no `permissions` field (undefined), all tools are allowed
 * (backwards-compatible with agents that don't define permissions).
 */

import { resolve, normalize, dirname, basename, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

// ── Core Platform Tools (always allowed, bypass all permission checks) ────

/**
 * Tools that are fundamental to the platform's operation and must never
 * be blocked by permission rules. These bypass both user-level RBAC
 * and agent-level permission checks.
 *
 * Only the platform's own MCP tools are listed here. Third-party MCP servers
 * that happen to use the mcp__ prefix are subject to normal permission checks.
 */
export const CORE_PLATFORM_TOOLS = new Set([
  // Agent delegation (mcp__agent__ server)
  "mcp__agent__start",
  "mcp__agent__stop",
  "mcp__agent__message",
  // Scheduler (mcp__scheduler__ server)
  "mcp__scheduler__create",
  "mcp__scheduler__list",
  "mcp__scheduler__update",
  "mcp__scheduler__delete",
]);

/** Returns true if the tool should bypass all permission checks. */
export function isCorePlatformTool(tool: string): boolean {
  return CORE_PLATFORM_TOOLS.has(tool);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentPermissionRule {
  action: "allow" | "deny" | "ask";
  /** Tool name, or "*" for all tools */
  tool: string;
  /** Path glob (file tools) or command glob (Bash). Undefined = match all invocations. */
  pattern?: string;
}

export interface PermissionContext {
  /** User home directory — native path */
  homeDir: string;
  /** Agent's working directory — native path */
  agentCwd: string;
  /** Platform root directory (~/.stockade) — native path. `/` prefix resolves here. */
  platformRoot: string;
}

// ── Rule Parsing ───────────────────────────────────────────────────────────

/**
 * Parse a permission rule string into a structured rule.
 *
 * @example parseRule("deny:Write(/config/**)")
 * @example parseRule("allow:Bash(git *)")
 * @example parseRule("allow:*")
 * @example parseRule("deny:Bash")
 */
export function parseRule(rule: string): AgentPermissionRule {
  const colonIdx = rule.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`Invalid permission rule (missing ':'): ${rule}`);
  }

  const action = rule.slice(0, colonIdx);
  if (action !== "allow" && action !== "deny" && action !== "ask") {
    throw new Error(`Invalid action "${action}" in rule: ${rule}`);
  }

  const selector = rule.slice(colonIdx + 1);
  if (!selector) {
    throw new Error(`Empty selector in rule: ${rule}`);
  }

  // Wildcard: matches all tools
  if (selector === "*") {
    return { action, tool: "*" };
  }

  // Tool(pattern) format
  const parenOpen = selector.indexOf("(");
  if (parenOpen !== -1) {
    if (!selector.endsWith(")")) {
      throw new Error(`Unclosed parenthesis in rule: ${rule}`);
    }
    const tool = selector.slice(0, parenOpen);
    const pattern = selector.slice(parenOpen + 1, -1);
    if (!tool) throw new Error(`Empty tool name in rule: ${rule}`);
    if (!pattern) throw new Error(`Empty pattern in rule: ${rule}`);
    return { action, tool, pattern };
  }

  // Plain tool name
  return { action, tool: selector };
}

// ── POSIX Path Normalization ──────────────────────────────────────────────

/**
 * Convert a native OS path to POSIX form.
 *
 * - Windows: `C:\Users\mail\file.txt` → `/c/Users/mail/file.txt`
 * - Unix: unchanged (already POSIX)
 *
 * This matches Claude Code's internal path normalization on Windows.
 */
export function toPosixPath(nativePath: string): string {
  // Replace backslashes with forward slashes
  let p = nativePath.replace(/\\/g, "/");

  // Convert Windows drive letter: C:/ → /c/
  const driveMatch = p.match(/^([A-Za-z]):\//);
  if (driveMatch) {
    p = `/${driveMatch[1].toLowerCase()}${p.slice(2)}`;
  }

  return p;
}

// ── Path Handling ──────────────────────────────────────────────────────────

/** Tools that operate on file paths, mapped to their input field name. */
export const FILE_PATH_FIELDS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "path",
  Grep: "path",
};

/**
 * Tool groups: rules written for one tool also apply to its group members.
 * e.g. `allow:Read(/agents/**)` also allows Glob and Grep on that path,
 * and `deny:Write(/config/**)` also denies Edit on that path.
 */
const TOOL_GROUPS: Record<string, string[]> = {
  Read: ["Read", "Glob", "Grep"],
  Write: ["Write", "Edit"],
};

/**
 * Extract the target file path from a tool invocation's input.
 * Returns null for non-file tools or when no path is present.
 */
export function extractFilePath(
  tool: string,
  input: Record<string, unknown>,
): string | null {
  const field = FILE_PATH_FIELDS[tool];
  if (!field) return null;
  const value = input[field];
  return typeof value === "string" && value ? value : null;
}

/**
 * Expand a rule pattern to an absolute POSIX path (with glob chars preserved).
 *
 * Prefix conventions:
 *   - `//...` → absolute POSIX path (already expanded, strip leading `/`)
 *   - `~/...` → home directory
 *   - `/...`  → platform root (~/.stockade)
 *   - `./...` or bare → agent cwd
 */
export function expandPattern(
  pattern: string,
  ctx: PermissionContext,
): string {
  // // → absolute POSIX path (strip one leading /)
  if (pattern.startsWith("//")) {
    return pattern.slice(1);
  }

  // ~/ → home directory
  if (pattern === "~") {
    return toPosixPath(resolve(ctx.homeDir));
  }
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) {
    const rest = pattern.slice(2);
    return toPosixPath(resolve(ctx.homeDir, rest));
  }

  // / → platform root (~/.stockade)
  if (pattern.startsWith("/")) {
    const rest = pattern.slice(1);
    return toPosixPath(resolve(ctx.platformRoot, rest));
  }

  // ./ or bare → agent cwd
  const rest = pattern.startsWith("./") || pattern.startsWith(".\\")
    ? pattern.slice(2)
    : pattern;
  return toPosixPath(resolve(ctx.agentCwd, rest));
}

/**
 * Expand an input file path (from a tool invocation) to an absolute native path.
 * The result is then passed to resolveCanonicalPath() and toPosixPath().
 */
export function expandInputPath(
  filePath: string,
  ctx: PermissionContext,
): string {
  // Expand ~ to home directory
  if (filePath === "~") {
    return resolve(ctx.homeDir);
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return resolve(ctx.homeDir, filePath.slice(2));
  }
  // Make absolute if relative
  if (!isAbsolute(filePath)) {
    return resolve(ctx.agentCwd, filePath);
  }
  // Already absolute — normalize
  return resolve(filePath);
}

/**
 * Resolve a path to its canonical form (following symlinks), then
 * convert to POSIX form.
 *
 * For non-existent paths (e.g. a Write to a new file), resolves the
 * deepest existing ancestor and appends the remaining segments.
 */
export async function resolveCanonicalPath(nativePath: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(nativePath);
  } catch {
    // Path doesn't exist — resolve parent + leaf
    const dir = dirname(nativePath);
    const leaf = basename(nativePath);
    try {
      const resolvedDir = await realpath(dir);
      canonical = resolve(resolvedDir, leaf);
    } catch {
      // Parent doesn't exist either — return normalized path
      canonical = normalize(nativePath);
    }
  }
  return toPosixPath(canonical);
}

// ── Glob Matching ──────────────────────────────────────────────────────────

/**
 * Match a string against a glob pattern.
 *
 * In path mode (default, for file tools):
 *   - `**`  — matches any path including separators (zero or more segments)
 *   - `*`   — matches anything except path separators
 *   - `?`   — matches a single non-separator character
 *
 * In text mode (pathMode=false, for Bash commands):
 *   - `*`   — matches anything (including `/` and spaces)
 *   - `?`   — matches any single character
 *   - `**`  — same as `*` (no path semantics)
 *
 * Both inputs should already be in POSIX form (forward slashes).
 * Case-insensitive on Windows (process.platform === "win32").
 */
export function matchGlob(
  value: string,
  pattern: string,
  pathMode: boolean = true,
): boolean {
  // Ensure forward slashes (defensive — callers should already normalize)
  const v = value.replace(/\\/g, "/");
  const p = pattern.replace(/\\/g, "/");

  let regex = "^";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      if (pathMode && p[i + 2] === "/") {
        // **/ — matches zero or more complete path segments
        regex += "(?:.*/)?";
        i += 3;
      } else {
        // ** — matches everything
        regex += ".*";
        i += 2;
      }
    } else if (p[i] === "*") {
      regex += pathMode ? "[^/]*" : ".*";
      i++;
    } else if (p[i] === "?") {
      regex += pathMode ? "[^/]" : ".";
      i++;
    } else {
      // Escape regex special characters
      regex += p[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  regex += "$";

  const flags = process.platform === "win32" ? "i" : "";
  return new RegExp(regex, flags).test(v);
}

// ── Rule Evaluation ────────────────────────────────────────────────────────

/**
 * Check if a parsed rule matches a tool invocation.
 *
 * For file-based tools: expands the rule pattern via prefix conventions,
 * expands the input path to canonical POSIX form, then glob-matches.
 *
 * For Bash: glob-matches the command string against the pattern.
 *
 * For other tools or rules without patterns: matches by tool name only.
 */
export async function ruleMatches(
  rule: AgentPermissionRule,
  tool: string,
  input: Record<string, unknown>,
  ctx: PermissionContext,
): Promise<boolean> {
  // Tool name check — "*" matches all tools, tool groups expand matches
  if (rule.tool !== "*" && rule.tool !== tool) {
    const group = TOOL_GROUPS[rule.tool];
    if (!group || !group.includes(tool)) return false;
  }

  // No pattern → matches all invocations of this tool (or all tools if *)
  if (!rule.pattern) return true;

  // ── File-based tools: path-aware matching ──
  const filePath = extractFilePath(tool, input);
  if (filePath !== null) {
    const posixPattern = expandPattern(rule.pattern, ctx);
    const nativeInput = expandInputPath(filePath, ctx);
    const posixInput = await resolveCanonicalPath(nativeInput);
    return matchGlob(posixInput, posixPattern);
  }

  // ── Bash: command string matching (text mode — * matches everything) ──
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    return matchGlob(command, rule.pattern, false);
  }

  // ── Other tools with a pattern: no match ──
  // Patterns are only meaningful for file tools and Bash.
  // A rule like `deny:WebSearch(foo)` never matches — use `deny:WebSearch` instead.
  return false;
}

/**
 * Evaluate agent-level permissions for a tool invocation.
 *
 * Walks rules top-to-bottom; the first matching rule determines the outcome.
 *
 * - `undefined` rules → "allow" (no agent-level restrictions, backwards-compatible)
 * - Empty array → "ask" (no rules match = HITL approval required)
 * - Non-empty array → first match wins, implicit "ask" if none match
 */
export async function evaluateAgentPermissions(
  rules: string[] | undefined,
  tool: string,
  input: Record<string, unknown>,
  ctx: PermissionContext,
): Promise<"allow" | "deny" | "ask"> {
  // No permissions field → no agent-level restrictions
  if (rules === undefined || rules === null) return "allow";

  const parsed = rules.map(parseRule);

  for (const rule of parsed) {
    if (await ruleMatches(rule, tool, input, ctx)) {
      return rule.action;
    }
  }

  // No rule matched → ask (HITL approval required)
  return "ask";
}

/**
 * Format a tool invocation for display in an approval prompt.
 * Returns a human-readable description of what the tool is trying to do.
 */
export function formatToolApproval(tool: string, input: Record<string, unknown>): string {
  const lines = [`Tool: ${tool}`];

  if (tool === "Bash" && input.command) {
    lines.push(`Command: ${input.command}`);
  } else if (input.file_path) {
    lines.push(`Path: ${input.file_path}`);
  } else if (input.path) {
    lines.push(`Path: ${input.path}`);
  } else if (input.pattern) {
    lines.push(`Pattern: ${input.pattern}`);
  }

  if (input.description && typeof input.description === "string") {
    lines.push(`Description: ${input.description}`);
  }

  return lines.join("\n");
}
