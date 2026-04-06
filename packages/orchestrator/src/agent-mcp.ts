/**
 * Agent MCP tool handlers — orchestrator-side implementation of mcp__agent__*.
 *
 * Called by the callback server when workers invoke the agent MCP tools.
 *
 * Agent lifecycle:
 * - start (blocking): dispatches sub-agent, blocks HTTP call until done → returns { runId, result }
 * - start (background): dispatches sub-agent async → returns { runId } immediately,
 *   injects completion into parent worker when done
 * - stop: aborts a running sub-agent's worker session
 * - message: injects a message into a named or background sub-agent
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CallbackSession } from "./api/sessions.js";
import type { DispatchContext } from "./dispatcher.js";
import { dispatchToWorker } from "./dispatcher.js";
import { checkAccess, buildPermissionHook } from "./rbac.js";
import { resolveEffectivePermissions } from "./gatekeeper.js";
import type { WorkerManager } from "./workers/index.js";

interface AgentRun {
  runId: string;
  name?: string;
  /** Callback token of the parent session (for injection on background completion) */
  parentToken: string;
  /** Worker URL and session ID for inject/stop */
  workerUrl?: string;
  workerSessionId?: string;
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
): Promise<{ runId: string; result?: string }> {
  const { task, name, background = false } = args;

  // Self-spawn: no agentId → spawn a parallel copy of the calling agent
  const isSelfSpawn = !args.agentId;
  const agentId = args.agentId ?? parentCtx.agentId;

  // RBAC: check if the originating user can access the target agent
  if (!checkAccess(parentCtx.userId, parentCtx.userPlatform, agentId, parentCtx.platformConfig)) {
    throw new Error(`Access denied: user cannot invoke agent "${agentId}"`);
  }

  const targetConfig = parentCtx.allAgents.agents[agentId];
  if (!targetConfig) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  // Apply model override if specified
  const effectiveConfig = args.model
    ? { ...targetConfig, model: args.model }
    : targetConfig;

  // inline logic:
  // - Self-spawn is always inline (shares parent workspace) but loads settings/memory
  //   (unlike config-inline agents which suppress settings via forceParentCwd flag)
  // - Otherwise: explicit arg takes precedence, then agent's config flag
  const inline = isSelfSpawn ? true : (args.inline ?? targetConfig.inline ?? false);

  const runId = randomUUID();
  const run: AgentRun = {
    runId,
    name: name ?? undefined,
    parentToken: parentCtx.callbackToken,
    done: false,
  };
  runs.set(runId, run);
  if (name) namedRuns.set(name, runId);

  // Build sub-agent permission hook (uses original user's identity + target agent's rules)
  const subAgentCwd = inline
    ? parentCtx.agentCwd
    : resolve(parentCtx.agentsDir, agentId);
  const subEffectivePermissions = resolveEffectivePermissions(
    effectiveConfig.permissions,
    parentCtx.platformConfig.gatekeeper,
  );
  const subPermissionHook = buildPermissionHook(
    parentCtx.userId,
    parentCtx.userPlatform,
    parentCtx.platformConfig,
    subEffectivePermissions,
    subAgentCwd,
    parentCtx.platformRoot,
    parentCtx.askApproval,
  );

  // Self-spawns get unique scopes (fresh session each time, no resume across spawns)
  // Config sub-agents get stable scopes (session resumes across calls to same agent)
  const subScope = isSelfSpawn
    ? `self-spawn:${agentId}:${runId}`
    : `subagent:${agentId}:${parentCtx.callbackToken}`;

  const subMessage = {
    scope: subScope,
    content: task,
    userId: parentCtx.userId,
    platform: parentCtx.userPlatform,
  };

  // Build sub-agent dispatch context
  const subCtx: DispatchContext = {
    ...dispatchCtx,
    parentCwd: inline ? parentCtx.agentCwd : undefined,
    // Self-spawn: force parent cwd but allow settings/memory to load (unlike config-inline)
    forceParentCwd: isSelfSpawn,
    askApproval: parentCtx.askApproval,
    parentRunId: runId,
  };

  if (background) {
    // Capture what we need from the parent context before the async gap
    const onComplete = dispatchCtx.onBackgroundComplete;
    const parentScope = parentCtx.scope;
    const parentUserId = parentCtx.userId;
    const parentUserPlatform = parentCtx.userPlatform;
    const parentAskApproval = parentCtx.askApproval;
    const label = `"${name ?? agentId}" (${runId.slice(0, 8)})`;

    dispatchToWorker(agentId, subMessage, effectiveConfig, null, subCtx, subPermissionHook)
      .then(({ result }) => {
        run.done = true;
        if (name) namedRuns.delete(name);
        runs.delete(runId);

        const text = `[Background agent ${label} complete]:\n${result}`;
        if (onComplete) {
          onComplete(parentScope, text, { userId: parentUserId, userPlatform: parentUserPlatform, askApproval: parentAskApproval });
        } else {
          console.warn(`[agent-mcp] background agent ${label} completed but no onBackgroundComplete handler — result dropped`);
        }
      })
      .catch((err) => {
        run.done = true;
        if (name) namedRuns.delete(name);
        runs.delete(runId);

        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-mcp] background agent ${label} failed: ${errMsg}`);

        const text = `[Background agent ${label} failed]: ${errMsg}`;
        if (onComplete) {
          onComplete(parentScope, text, { userId: parentUserId, userPlatform: parentUserPlatform, askApproval: parentAskApproval });
        }
      });

    return { runId };
  }

  // Blocking: dispatch and wait for result
  try {
    const { result } = await dispatchToWorker(agentId, subMessage, effectiveConfig, null, subCtx, subPermissionHook);
    return { runId, result };
  } finally {
    run.done = true;
    if (name) namedRuns.delete(name);
    runs.delete(runId);
  }
}

export async function handleAgentStop(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.done) return;

  if (run.workerUrl && run.workerSessionId) {
    await fetch(`${run.workerUrl}/sessions/${run.workerSessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  run.done = true;
  if (run.name) namedRuns.delete(run.name);
  runs.delete(runId);
}

/** Inject a message into a running sub-agent by runId or name. Returns false if not found. */
export async function handleAgentMessage(target: string, text: string): Promise<boolean> {
  // Resolve name → runId
  const runId = namedRuns.has(target) ? namedRuns.get(target)! : target;
  const run = runs.get(runId);

  if (!run || run.done || !run.workerUrl || !run.workerSessionId) {
    return false;
  }

  const res = await fetch(`${run.workerUrl}/sessions/${run.workerSessionId}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });

  return res.ok;
}

/** Register the worker session ID for a run (called by dispatcher after session creation). */
export function registerRunSession(runId: string, workerUrl: string, workerSessionId: string): void {
  const run = runs.get(runId);
  if (run) {
    run.workerUrl = workerUrl;
    run.workerSessionId = workerSessionId;
  }
}
