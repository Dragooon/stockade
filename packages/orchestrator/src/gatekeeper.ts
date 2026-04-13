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
  /** Thinking token budget for the gatekeeper model. Enables extended thinking
   *  so the gatekeeper can reason through obfuscated or complex commands.
   *  Default: 1024. Set to 0 to disable thinking. */
  budget_tokens?: number;
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
  agentId?: string,
): AskApprovalFn {
  const threshold = config.auto_approve_risk ?? "low";

  return async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    let review: GatekeeperReview | undefined;

    const reviewStart = Date.now();
    try {
      review = await reviewToolInvocation(tool, input, agentConfig, config.budget_tokens);
      const reviewMs = Date.now() - reviewStart;
      console.log(
        `[gatekeeper] ${review.risk} "${tool}" — ${review.summary} (${(reviewMs / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      const reviewMs = Date.now() - reviewStart;
      console.error(`[gatekeeper] Review failed after ${(reviewMs / 1000).toFixed(1)}s:`, err instanceof Error ? err.message : err);
      // Fall through to user approval without review
    }

    if (review && shouldAutoApprove(review, threshold)) {
      // Auto-approved — notify channel (informational, no buttons)
      try {
        await channel.notifyAutoApproved(tool, input, review, agentId);
      } catch {
        // Best-effort notification
      }
      return true;
    }

    // Needs user approval — pass review to help them decide
    return channel.askUser(tool, input, review, agentId);
  };
}

// ── Anthropic Messages API call ────────────────────────────────────────────

/**
 * Default system prompt used when the gatekeeper agent's system prompt is empty.
 * Users should define their own in the agent config for full customizability.
 */
const DEFAULT_GATEKEEPER_SYSTEM = `You are a security gatekeeper. Assess tool invocation risk.

RESPONSE FORMAT — you MUST reply with exactly one line of raw JSON, nothing else:
{"risk":"low","summary":"short description"}

Do NOT wrap in markdown, code fences, or backticks. Do NOT add explanation text before or after. Just the JSON.

Risk values: low, medium, high, critical.
Summary: under 15 words, one sentence.

Risk guidelines:
- low: Read-only ops, safe searches, reading files, ls, cat, grep, git status/log/diff
- medium: Writing/editing files, build/test commands, dev dependency installs, git commit
- high: Deleting files, unfamiliar scripts, system config changes, external network requests, sensitive paths, git push
- critical: Root/admin ops, modifying credentials/secrets, rm -rf, force push, database mutations, sending data externally`;

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
  budgetTokens?: number,
): Promise<GatekeeperReview> {
  const systemPrompt = agentConfig.system || DEFAULT_GATEKEEPER_SYSTEM;
  const toolDescription = formatToolApproval(tool, input);

  const userMessage = `Assess the risk of this tool invocation:\n\nTool: ${tool}\n${toolDescription}\n\nFull input:\n${JSON.stringify(input, null, 2)}`;

  // Build thinking config: default 1024 tokens, 0 disables
  const effectiveBudget = budgetTokens ?? 1024;
  const thinking = effectiveBudget > 0
    ? { type: "enabled" as const, budgetTokens: effectiveBudget }
    : { type: "disabled" as const };

  try {
    let result = "";

    for await (const message of query({
      prompt: userMessage,
      options: {
        model: agentConfig.model,
        systemPrompt,
        thinking,
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
    // Aggressively extract JSON from model response — strip markdown fences,
    // leading/trailing prose, and find the first {...} object.
    let cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[^}]*"risk"\s*:\s*"[^"]+"\s*[,}][^}]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    const parsed = JSON.parse(cleaned);

    const risk = parsed.risk;
    if (!isValidRisk(risk)) {
      return fallbackReview("unknown", "invalid risk level in response");
    }

    return {
      risk,
      summary: String(parsed.summary ?? "No summary provided"),
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
    summary: `Could not assess "${tool}" (${reason}) — defaulting to medium`,
  };
}
