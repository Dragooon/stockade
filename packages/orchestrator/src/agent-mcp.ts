/**
 * Agent MCP tool handlers — orchestrator-side implementation of mcp__agent__*.
 *
 * Called by the callback server when workers invoke the agent MCP tools.
 *
 * Agent lifecycle:
 * - start (blocking): dispatches sub-agent via Redis bus, waits for result
 * - start (background): dispatches sub-agent async, injects completion into parent scope
 * - stop: publishes abort control signal for the sub-agent scope
 * - message: publishes message to the sub-agent's Redis channel (fire-and-forget)
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CallbackSession } from "./api/sessions.js";
import type { DispatchContext } from "./dispatcher.js";
import { checkAccess, buildPermissionHook } from "./rbac.js";
import { resolveEffectivePermissions } from "./gatekeeper.js";
import type { WorkerManager } from "./workers/index.js";
import type { OrchestratorBridge } from "./bus/orchestrator-bridge.js";
import type { AskApprovalFn } from "./types.js";

interface AgentRun {
  runId: string;
  name?: string;
  agentId: string;
  /** Scope of the sub-agent session (for messaging and stop). */
  scope: string;
  /** Callback token of the parent session (for context on background completion). */
  parentToken: string;
  done: boolean;
}

/** Active sub-agent runs: runId → AgentRun */
const runs = new Map<string, AgentRun>();

/** Named agent lookup: name → runId */
const namedRuns = new Map<string, string>();

export async function handleAgentStart(
  args: { agentId?: string; task: string; name?: string; background?: boolean; inline?: boolean; model?: string },
  parentCtx: CallbackSession,
  dispatchCtx: DispatchContext,
  workerManager: WorkerManager,
  bridge: OrchestratorBridge,
): Promise<{ runId: string; result?: string; files?: Array<{ filename: string; contentType: string; path: string; content?: string }> }> {
  const { task, name, background = false } = args;

  const isSelfSpawn = !args.agentId;
  const agentId = args.agentId ?? parentCtx.agentId;

  if (!checkAccess(parentCtx.userId, parentCtx.userPlatform, agentId, parentCtx.platformConfig)) {
    throw new Error(`Access denied: user cannot invoke agent "${agentId}"`);
  }

  const targetConfig = parentCtx.allAgents.agents[agentId];
  if (!targetConfig) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  const inline = isSelfSpawn ? true : (args.inline ?? targetConfig.inline ?? false);

  const runId = randomUUID();
  const subScope = isSelfSpawn
    ? `self-spawn:${agentId}:${runId}`
    : `subagent:${agentId}:${parentCtx.callbackToken}`;

  const run: AgentRun = {
    runId,
    name: name ?? undefined,
    agentId,
    scope: subScope,
    parentToken: parentCtx.callbackToken,
    done: false,
  };
  runs.set(runId, run);
  if (name) namedRuns.set(name, runId);

  const meta: Record<string, unknown> = {
    userId: parentCtx.userId,
    userPlatform: parentCtx.userPlatform,
    askApproval: parentCtx.askApproval,
    agentId,
    parentCwd: inline ? parentCtx.agentCwd : undefined,
    forceParentCwd: isSelfSpawn,
  };

  if (background) {
    const parentScope = parentCtx.scope;
    const parentUserId = parentCtx.userId;
    const parentUserPlatform = parentCtx.userPlatform;
    const parentAskApproval = parentCtx.askApproval;
    const label = `"${name ?? agentId}" (${runId.slice(0, 8)})`;

    bridge.sendAndWait(subScope, task, meta)
      .then((result) => {
        run.done = true;
        if (name) namedRuns.delete(name);
        runs.delete(runId);

        const text = `[Background agent ${label} complete]:\n${result}`;
        // Re-dispatch via bridge to inject completion into parent scope
        return bridge.sendAndWait(parentScope, text, {
          userId: parentUserId,
          userPlatform: parentUserPlatform,
          askApproval: parentAskApproval as AskApprovalFn | undefined,
        });
      })
      .catch((err) => {
        run.done = true;
        if (name) namedRuns.delete(name);
        runs.delete(runId);

        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-mcp] background agent ${label} failed: ${errMsg}`);

        bridge.sendAndWait(parentScope, `[Background agent ${label} failed]: ${errMsg}`, {
          userId: parentUserId,
          userPlatform: parentUserPlatform,
          askApproval: parentAskApproval as AskApprovalFn | undefined,
        }).catch(() => {});
      });

    return { runId };
  }

  // Blocking: dispatch and wait
  try {
    const response = await bridge.sendAndWait(subScope, task, meta);
    return { runId, result: response.text, files: response.files };
  } finally {
    run.done = true;
    if (name) namedRuns.delete(name);
    runs.delete(runId);
  }
}

export async function handleAgentStop(runId: string, bridge: OrchestratorBridge): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.done) return;

  // Publish abort control signal to the sub-agent's agent control channel
  await bridge.bus.publishControl(run.agentId, {
    kind: "control",
    action: "abort",
    scope: run.scope,
    timestamp: new Date().toISOString(),
  });

  run.done = true;
  if (run.name) namedRuns.delete(run.name);
  runs.delete(runId);
}

/**
 * Inject a message into a running sub-agent by runId or name.
 * Fire-and-forget — publishes to Redis message channel.
 * Returns false if the run is not found or already done.
 */
export async function handleAgentMessage(
  target: string,
  text: string,
  bridge: OrchestratorBridge,
): Promise<boolean> {
  const runId = namedRuns.has(target) ? namedRuns.get(target)! : target;
  const run = runs.get(runId);

  if (!run || run.done) return false;

  // Publish to sub-agent's scope message channel (fire-and-forget)
  await bridge.bus.publishMessage({
    kind: "user_message",
    correlationId: randomUUID(), // untracked — result will be silently dropped
    scope: run.scope,
    text,
    userId: "system",
    userPlatform: "internal",
    timestamp: new Date().toISOString(),
  });

  return true;
}

/** No longer needed — scope is tracked in AgentRun directly. Kept for compatibility. */
export function registerRunSession(_runId: string, _workerUrl: string, _workerSessionId: string): void {
  // No-op in Redis mode — scope is tracked at session creation time.
}
