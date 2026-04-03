import type { ContainerConfig, ContainersConfig } from "./containers/types.js";
import type { SchedulerConfig } from "./scheduler/types.js";
import type { GatekeeperConfig, GatekeeperReview } from "./gatekeeper.js";

/** Memory configuration for an agent */
export interface MemoryConfig {
  /** Enable auto-memory (Claude Code reads/writes memory files). Default: true */
  enabled?: boolean;
  /** Enable background memory consolidation. Default: false */
  autoDream?: boolean;
}

/** Agent configuration from agents.yaml */
export interface AgentConfig {
  model: string;
  system?: string;
  /** "append" uses SDK's Claude Code preset + appends system. "replace" uses system as-is. */
  system_mode?: "append" | "replace";
  /** Effort level for reasoning depth: low, medium, high, max. */
  effort?: "low" | "medium" | "high" | "max";
  tools?: string[];
  sandboxed?: boolean;
  port?: number;
  url?: string;
  subagents?: string[];
  credentials?: string[];
  store_keys?: string[];
  container?: ContainerConfig;
  /** Memory configuration. Default: enabled with no autoDream. */
  memory?: MemoryConfig;
  /**
   * Ordered permission rules for this agent.
   * Format: "allow:Selector" or "deny:Selector" — first match wins.
   * If undefined, all tools are allowed (no agent-level restrictions).
   * If defined, implicit deny when no rule matches.
   */
  permissions?: string[];
  /** Skill names to sync from ~/.claude/skills/ into this agent's workspace. */
  skills?: string[];
}

export type { ContainerConfig, ContainersConfig };
export type { SchedulerConfig };

/** Top-level agents.yaml shape */
export interface AgentsConfig {
  agents: Record<string, AgentConfig>;
}

/** A single channel binding in platform.yaml */
export interface ChannelBinding {
  server: string;
  agent: string;
  channels: string | string[];
}

/**
 * Resolved paths configuration — all directories the platform uses.
 *
 * Default base: `~/.stockade` (decoupled from the source repo).
 * This keeps agent workspaces, sessions, and runtime data in a stable
 * location independent of where the project source lives.
 */
export interface PathsConfig {
  /** Root data directory (default: ~/.stockade) */
  data_dir: string;
  /** Per-agent workspace root (default: <data_dir>/agents) */
  agents_dir: string;
  /** Sessions database path (default: <data_dir>/sessions.db) */
  sessions_db: string;
  /** Container provisioning temp files (default: <data_dir>/containers) */
  containers_dir: string;
  /** Config directory (set at runtime from loadConfig's configDir arg) */
  config_dir: string;
}

/** Platform configuration from platform.yaml */
export interface PlatformConfig {
  channels: {
    terminal?: { enabled: boolean; agent: string };
    discord?: {
      enabled: boolean;
      token: string;
      bindings: ChannelBinding[];
    };
  };
  rbac: {
    roles: Record<string, { permissions: string[]; deny?: string[]; allow?: string[] }>;
    users: Record<
      string,
      {
        roles: string[];
        identities: Record<string, string>;
      }
    >;
  };
  containers?: ContainersConfig;
  scheduler?: SchedulerConfig;
  paths?: PathsConfig;
  gatekeeper?: GatekeeperConfig;
}

/** An attachment from a channel message (e.g., Discord file upload). */
export interface ChannelAttachment {
  /** Original filename */
  filename: string;
  /** MIME type (e.g., "image/png", "text/plain") */
  contentType: string;
  /** Raw content — base64 for images, plain text for text files */
  data: string;
  /** File size in bytes (original, before encoding) */
  size: number;
}

/** Unified message from any channel */
export interface ChannelMessage {
  scope: string;
  content: string;
  userId: string;
  platform: string;
  /** File attachments from the channel (images, text files, etc.) */
  attachments?: ChannelAttachment[];
}

/** Result returned from dispatching to an agent */
export interface DispatchResult {
  result: string;
  sessionId: string;
}

/**
 * Callback for HITL (Human-in-the-Loop) approval when a tool invocation
 * matches an `ask` rule or falls through without matching any rule.
 *
 * Created by the orchestrator (wrapping channel callbacks with gatekeeper
 * logic) and threaded through the dispatch chain so approval requests
 * go back to the originating channel.
 *
 * @returns true to allow the tool invocation, false to deny
 */
export type AskApprovalFn = (
  tool: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

/**
 * Channel-provided callbacks for the tool approval flow.
 *
 * Channels implement this interface to provide rendering for approval
 * requests and notifications. Channels do NOT contain gatekeeper logic —
 * they only know how to display information and collect user decisions.
 *
 * The orchestrator wraps these callbacks with gatekeeper logic (when enabled)
 * to produce a single `AskApprovalFn` consumed by the RBAC layer.
 */
export interface ApprovalChannel {
  /**
   * Present a tool invocation for user approval.
   * Optionally includes a gatekeeper review to help the user decide.
   *
   * @returns true if the user approved, false if denied or timed out
   */
  askUser: (
    tool: string,
    input: Record<string, unknown>,
    review?: GatekeeperReview,
  ) => Promise<boolean>;

  /**
   * Notify the channel about a tool invocation that was auto-approved
   * by the gatekeeper. Informational only — no user action required.
   *
   * This ensures all tool invocations are visible in the channel,
   * even when they don't require manual approval.
   */
  notifyAutoApproved: (
    tool: string,
    input: Record<string, unknown>,
    review: GatekeeperReview,
  ) => Promise<void>;
}

/** Resolved user info from RBAC */
export interface ResolvedUser {
  username: string;
  roles: string[];
  permissions: string[];
  /** Tool deny rules — blocks matching tool invocations */
  deny: string[];
  /** Tool allow rules — exceptions that override deny rules */
  allow: string[];
}
