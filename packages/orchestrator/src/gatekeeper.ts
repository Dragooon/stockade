/**
 * Gatekeeper — AI-powered tool invocation risk assessment.
 *
 * Before a tool invocation reaches the user for HITL approval, the Gatekeeper
 * agent evaluates the risk level. The gatekeeper is itself an agent defined in
 * config.yaml — its model and system prompt are fully customizable.
 *
 * Based on the configured threshold:
 *   - Low-risk actions can be auto-approved (still notified to the channel)
 *   - Higher-risk actions are presented to the user with the risk review
 *     attached, helping them make an informed approval decision.
 *
 * This provides a security layer for users who may not fully understand
 * what a tool invocation does.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { formatToolApproval } from "./permissions.js";
import type { AgentConfig, AskApprovalFn, ApprovalChannel } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface GatekeeperReview {
  /** Assessed risk level */
  risk: RiskLevel;
  /** One-line summary of what the tool invocation does */
  summary: string;
  /** Optional explanation of why this risk level was assigned */
  reasoning?: string;
}

export interface GatekeeperConfig {
  /** Enable/disable the gatekeeper. Default: false */
  enabled: boolean;
  /**
   * Agent ID to use as the gatekeeper (references an agent in config.yaml).
   * The agent's model and system prompt are used for the review call.
   */
  agent: string;
  /** Auto-approve invocations at or below this risk level. Default: "low" */
  auto_approve_risk?: RiskLevel;
}

// ── Risk comparison ────────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Check if a review's risk level is at or below the auto-approve threshold.
 */
export function shouldAutoApprove(
  review: GatekeeperReview,
  threshold: RiskLevel,
): boolean {
  return RISK_ORDER[review.risk] <= RISK_ORDER[threshold];
}

// ── Permission resolution ──────────────────────────────────────────────────

/**
 * Resolve effective permissions for an agent, accounting for gatekeeper.
 *
 * When gatekeeper is enabled and an agent has no `permissions` field,
 * injects `["ask:*"]` so every tool invocation passes through the
 * gatekeeper review instead of being silently allowed.
 *
 * When gatekeeper is disabled, returns the agent's permissions as-is
 * (undefined = allow all, backward-compatible).
 */
export function resolveEffectivePermissions(
  agentPermissions: string[] | undefined,
  gatekeeperConfig: GatekeeperConfig | undefined,
): string[] | undefined {
  if (agentPermissions !== undefined) return agentPermissions;
  if (gatekeeperConfig?.enabled) return ["ask:*"];
  return undefined;
}

// ── Orchestration-layer wrapper ─────────────────────────────────────────────

/**
 * Build a gatekeeper-wrapped AskApprovalFn from channel callbacks.
 *
 * This is the single integration point between the gatekeeper and channels.
 * All gatekeeper decision logic lives here — channels only render.
 *
 * Flow:
 *   1. Call the gatekeeper agent to assess risk
 *   2. If risk <= threshold → auto-approve + notify channel (no buttons)
 *   3. If risk > threshold → present to user with the review attached
 *   4. If gatekeeper fails → fall through to user approval without review
 *
 * @param channel     Channel-provided rendering callbacks
 * @param config      Gatekeeper configuration (threshold, agent ID)
 * @param agentConfig Resolved agent config for the gatekeeper agent (model + system prompt)
 */
export function buildGatedAskApproval(
  channel: ApprovalChannel,
  config: GatekeeperConfig,
  agentConfig: AgentConfig,
): AskApprovalFn {
  const threshold = config.auto_approve_risk ?? "low";

  return async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    let review: GatekeeperReview | undefined;

    try {
      review = await reviewToolInvocation(tool, input, agentConfig);
    } catch (err) {
      console.error("[gatekeeper] Review failed:", err instanceof Error ? err.message : err);
      // Fall through to user approval without review
    }

    if (review && shouldAutoApprove(review, threshold)) {
      // Auto-approved — notify channel (informational, no buttons)
      try {
        await channel.notifyAutoApproved(tool, input, review);
      } catch {
        // Best-effort notification
      }
      return true;
    }

    // Needs user approval — pass review to help them decide
    return channel.askUser(tool, input, review);
  };
}

// ── Anthropic Messages API call ────────────────────────────────────────────

/**
 * Default system prompt used when the gatekeeper agent's system prompt is empty.
 * Users should define their own in the agent config for full customizability.
 */
const DEFAULT_GATEKEEPER_SYSTEM = `You are a security gatekeeper for an AI agent platform. Your job is to assess the risk level of tool invocations that an AI agent wants to execute.

You will be given a tool name and its arguments. Evaluate the risk and respond with ONLY a JSON object (no markdown, no code fences):

{"risk": "low|medium|high|critical", "summary": "one short sentence max"}

Keep the summary under 15 words. No reasoning field needed.

Risk level guidelines:
- **low**: Read-only operations, safe searches, reading files, listing directories, non-destructive commands (git status, ls, cat, grep, echo)
- **medium**: Writing/editing files in expected locations, running build/test commands, installing dev dependencies, git commits
- **high**: Deleting files, running unfamiliar scripts, modifying system configuration, network requests to external services, writing to sensitive paths, package installs with post-install scripts, git push
- **critical**: Running as root/admin, modifying auth/credentials, accessing secrets, destructive git operations (force push, reset --hard), rm -rf, modifying CI/CD pipelines, database mutations, sending data to external endpoints

Consider:
1. Can this action be easily reversed?
2. Does it affect shared state or external systems?
3. Could it leak sensitive information?
4. Does the command look obfuscated or suspicious?
5. Is the scope of the action proportional to what's described?`;

/**
 * Call the Anthropic Messages API to get a risk assessment for a tool invocation.
 *
 * Uses fetch directly (no SDK dependency) against the Messages API.
 * The model and system prompt come from the referenced agent config.
 * Requires ANTHROPIC_API_KEY in the environment.
 */
export async function reviewToolInvocation(
  tool: string,
  input: Record<string, unknown>,
  agentConfig: AgentConfig,
): Promise<GatekeeperReview> {
  const systemPrompt = agentConfig.system || DEFAULT_GATEKEEPER_SYSTEM;
  const toolDescription = formatToolApproval(tool, input);

  const userMessage = `Assess the risk of this tool invocation:\n\nTool: ${tool}\n${toolDescription}\n\nFull input:\n${JSON.stringify(input, null, 2)}`;

  try {
    let result = "";

    for await (const message of query({
      prompt: userMessage,
      options: {
        model: agentConfig.model,
        systemPrompt,
        maxTurns: 1,
        allowedTools: [],
      } as any,
    })) {
      if ("result" in message) result = (message as { result: string }).result;
    }

    return parseReview(result);
  } catch (err) {
    console.error(
      "[gatekeeper] Request failed:",
      err instanceof Error ? err.message : err,
    );
    return fallbackReview(tool, "request failed");
  }
}

/**
 * Parse the model's JSON response into a GatekeeperReview.
 * Falls back to medium risk if parsing fails.
 */
function parseReview(text: string): GatekeeperReview {
  try {
    // Strip markdown code fences if present (model shouldn't, but be defensive)
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned);

    const risk = parsed.risk;
    if (!isValidRisk(risk)) {
      return fallbackReview("unknown", "invalid risk level in response");
    }

    return {
      risk,
      summary: String(parsed.summary ?? "No summary provided"),
      reasoning: String(parsed.reasoning ?? "No reasoning provided"),
    };
  } catch {
    console.error("[gatekeeper] Failed to parse response:", text.slice(0, 200));
    return fallbackReview("unknown", "failed to parse model response");
  }
}

function isValidRisk(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

/**
 * Fallback review when the gatekeeper cannot run — defaults to medium risk
 * so auto-approve (which defaults to "low") won't pass it through silently.
 */
function fallbackReview(tool: string, reason: string): GatekeeperReview {
  return {
    risk: "medium",
    summary: `Could not assess "${tool}" (${reason})`,
    reasoning: `Gatekeeper was unable to complete the review: ${reason}. Defaulting to medium risk for safety.`,
  };
}
