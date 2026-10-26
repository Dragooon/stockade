/**
 * SessionManager — persistent agent session lifecycle.
 *
 * Replaces the per-dispatch setup/teardown in dispatcher.ts:
 *   - Sessions are created once per scope and reused across messages.
 *   - Proxy tokens and callback sessions live for the session lifetime.
 *   - Workers subscribe to Redis for incoming messages; no SSE needed.
 *
 * Session lifecycle:
 *   ensureSession() → ACTIVE → idle timer fires → closeSession()
 *                              OR explicit closeSession(scope, reason)
 */

import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  AgentConfig,
  AgentsConfig,
  AskApprovalFn,
  AskQuestionsFn,
  PlatformConfig,
} from "../types.js";
import type { WorkerManager } from "../workers/index.js";
import {
  createCallbackSession,
  deleteCallbackSession,
  updateCallbackSession,
} from "../api/sessions.js";
import { resolveAgent, resolveBinding } from "../router.js";
import { onHost } from "../host-url.js";
import {
  buildSystemPrompt,
  buildSessionSdkSettings,
  platformDisallowedTools,
} from "../dispatcher.js";
import type { EventBus } from "./event-bus.js";
import type { ConcurrencyGate } from "./concurrency-gate.js";
import { appendLog } from "../log.js";
import { canUsePeers } from "../peers.js";
import { resolveRunAs, syncTranscript } from "../run-as.js";
import { workerHeaders } from "../workers/auth.js";

const LOG_DIR = join(homedir(), ".stockade", "logs");
const LOG_FILE = join(LOG_DIR, "dispatch.log");
mkdirSync(LOG_DIR, { recursive: true });

function sessionLog(message: string): void {
  console.log(message);
  appendLog(LOG_FILE, message);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionManagerDeps {
  bus: EventBus;
  gate: ConcurrencyGate;
  allAgents: AgentsConfig;
  platform: PlatformConfig;
  agentsDir: string;
  platformRoot: string;
  workerManager: WorkerManager;
  proxy?: { gatewayUrl: string; host: string; caCertPath: string };
  orchestratorCallbackUrl: string;
  schedulerEnabled?: boolean;
  redisUrl: string;
  getSessionId: (scope: string) => string | null;
  setSessionId: (scope: string, sdkSessionId: string) => void;
  deleteSessionId: (scope: string) => void;
  /** Agent of an app:/peer: scope from scope_bindings (D3b §6), null if unbound. */
  boundAgent?: (scope: string) => string | null;
}

export interface SessionMeta {
  userId: string;
  userPlatform: string;
  askApproval?: AskApprovalFn;
  /** AskUserQuestion in the originating channel (refreshed on every message). */
  askQuestions?: AskQuestionsFn;
  /** When true: don't RESUME an existing SDK session (start fresh). Used by both
   * scheduler isolated tasks AND stale-session retries. Does NOT by itself prevent
   * persisting the freshly-created session id — see `ephemeral` for that. */
  noSession?: boolean;
  /** When true: never persist the SDK session id to sessions.db (scheduler isolated
   * tasks only). Stale-session retries must NOT set this, otherwise the recovered
   * session id is never written back and the scope re-resumes the dead id forever
   * (permanent history-less cold-loop). */
  ephemeral?: boolean;
  /** Override agentId (for sub-agents where scope doesn't resolve via router). */
  agentId?: string;
  /** Parent agent's cwd (inline sub-agents share workspace). */
  parentCwd?: string;
  /** Parent agent's id (inline sub-agents reuse parent's running worker container). */
  parentAgentId?: string;
  /** Force parent cwd even for self-spawns (loads settings normally). */
  forceParentCwd?: boolean;
  /** /sudo session: Claude runs as the agent's sudo_user. Set only by the
   * orchestrator for registered sudo scopes, never by agents or the scheduler. */
  sudo?: boolean;
  /** Peer hops behind this message (0 or absent when a person sent it). Set only by the orchestrator. */
  hops?: number;
}

export interface ManagedSession {
  scope: string;
  agentId: string;
  callbackToken: string;
  workerUrl: string;
  workerSessionId: string;
  /** Agent cwd on the host filesystem (for attachment saving). */
  agentCwd: string;
  /** Whether the agent runs in a Docker sandbox — used to translate
   * host attachment paths to /workspace paths in prompts. */
  sandboxed: boolean;
  proxyToken?: string;
  sdkSessionId: string | null;
  /** Ephemeral session — its sdkSessionId is never persisted to sessions.db.
   * Set true ONLY for scheduler tasks dispatched with meta.ephemeral so a fresh
   * SDK session per fire never overwrites the user's resume mapping. NOTE: this is
   * deliberately NOT set for stale-session retries — those must persist their
   * recovered id so the conversation regains continuity on the next message. */
  isolated: boolean;
  /** Runs as the agent's sudo_user (see SessionMeta.sudo). */
  sudo: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
}

// ── Session Manager ────────────────────────────────────────────────────────

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly deps: SessionManagerDeps) {}

  /**
   * Ensure a persistent session exists for a scope.
   * Idempotent — if the session already exists, touches the idle timer and
   * updates the askApproval callback on the callback session.
   */
  async ensureSession(
    scope: string,
    meta: SessionMeta,
  ): Promise<ManagedSession> {
    const existing = this.sessions.get(scope);
    if (existing) {
      // A scope is either a sudo scope or not, for its whole life. Never let a
      // non-sudo dispatch (e.g. a scheduled task) ride an open sudo session.
      if (existing.sudo !== !!meta.sudo) {
        throw new Error(existing.sudo
          ? "This scope has an open sudo session; only sudo dispatches may use it"
          : "This scope has an open everyday session; close it before a sudo dispatch");
      }
      // Refresh idle timer
      clearTimeout(existing.idleTimer);
      existing.idleTimer = this.startIdleTimer(scope);

      // Update identity and HITL callbacks on the long-lived callback session: the latest
      // message's sender applies, mid-turn included (per-channel permissions are the boundary).
      updateCallbackSession(existing.callbackToken, {
        userId: meta.userId,
        userPlatform: meta.userPlatform,
        askApproval: meta.askApproval,
        askQuestions: meta.askQuestions,
        hops: meta.hops ?? 0,
      });

      return existing;
    }

    return this.createSession(scope, meta);
  }

  /** Close and clean up a session. */
  async closeSession(
    scope: string,
    reason: string,
    opts?: { skipRevoke?: boolean },
  ): Promise<void> {
    const session = this.sessions.get(scope);
    if (!session) return;

    sessionLog(`[session] closing ${scope.slice(0, 40)} reason=${reason}`);

    clearTimeout(session.idleTimer);
    this.sessions.delete(scope);

    await Promise.allSettled([
      this.deps.bus.unsubscribeEvents(scope),
      opts?.skipRevoke ? Promise.resolve() : this.revokeProxyToken(session.proxyToken),
      this.deleteWorkerSession(session.workerUrl, session.workerSessionId),
    ]);

    deleteCallbackSession(session.callbackToken);
    this.deps.gate.release(scope);
    await this.deps.bus.deleteSession(scope).catch(() => {});
    // Ephemeral subagent sessions are never resumed — remove their DB entry so
    // the sessions table doesn't accumulate stale rows for every subagent invocation.
    // Stable named-session scopes (containing ":session:") are kept for resumption.
    const isEphemeralSubagent =
      (scope.startsWith("subagent:") || scope.startsWith("self-spawn:")) &&
      !scope.includes(":session:");
    if (isEphemeralSubagent) {
      this.deps.deleteSessionId(scope);
    }
  }

  /**
   * Close all active sessions (on orchestrator shutdown).
   *
   * skipRevoke=true — skip proxy token revocation. Use on graceful restart so
   * containers can be reconnected with their existing (still-valid) proxy tokens.
   */
  async closeAll(opts?: { skipRevoke?: boolean }): Promise<void> {
    const scopes = [...this.sessions.keys()];
    await Promise.allSettled(scopes.map((s) => this.closeSession(s, "shutdown", opts)));
  }

  /** Called by the bridge when a started event carries the SDK session ID. */
  updateSdkSessionId(scope: string, sdkSessionId: string): void {
    const session = this.sessions.get(scope);
    if (!session) return;
    session.sdkSessionId = sdkSessionId;
    if (!session.idleTimer) return; // safety guard
    if (session.isolated) return;   // ephemeral — must not pollute sessions.db
    this.deps.setSessionId(scope, sdkSessionId);
  }

  /**
   * Called by the bridge on stale_session.
   * Signals the worker to clear its SDK session and start fresh.
   */
  async resetSdkSession(scope: string): Promise<void> {
    const session = this.sessions.get(scope);
    if (!session) return;
    session.sdkSessionId = null;
    await this.deps.bus.publishControl(session.agentId, {
      kind: "control",
      action: "reset_session",
      scope,
      reason: "stale_session",
      timestamp: new Date().toISOString(),
    });
  }

  /** Get a managed session by scope (or undefined if not active). */
  get(scope: string): ManagedSession | undefined {
    return this.sessions.get(scope);
  }

  /**
   * Refresh the idle timer on worker activity (called per turn by the bridge).
   *
   * Without this, the idle timer is only reset by a new inbound user message
   * (ensureSession), so it measures time-since-last-message rather than
   * time-since-last-activity. A long-running task that emits many turns but no
   * new user message looks "idle" and gets closed mid-flight — racing the
   * dispatch auto-continue, which then cold-boots a fresh, history-less session.
   */
  touch(scope: string): void {
    const session = this.sessions.get(scope);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.startIdleTimer(scope);
  }

  /** Every scope with a live session. */
  liveScopes(): string[] {
    return [...this.sessions.keys()];
  }

  /** Return all active scopes for a given agentId. Used for worker-restart recovery. */
  getScopesByAgentId(agentId: string): Set<string> {
    const scopes = new Set<string>();
    for (const [scope, session] of this.sessions) {
      if (session.agentId === agentId) scopes.add(scope);
    }
    return scopes;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async createSession(scope: string, meta: SessionMeta): Promise<ManagedSession> {
    const { deps } = this;

    // ── Resolve agent ──
    let agentId: string;
    // Per-binding overrides (e.g. a channel pinned to a specific model/effort).
    // Only sourced from binding resolution — an explicit meta.agentId (/agent: prefix,
    // subagent, self-spawn) keeps that agent's own defaults.
    let bindingOverride: { model?: string; effort?: AgentConfig["effort"] } = {};
    const boundAgentId = meta.agentId ? null : deps.boundAgent?.(scope) ?? null;
    if (meta.agentId) {
      agentId = meta.agentId;
    } else if (boundAgentId) {
      agentId = boundAgentId;
    } else {
      try {
        const binding = resolveBinding(scope, deps.platform);
        agentId = binding.agentId;
        bindingOverride = { model: binding.model, effort: binding.effort };
      } catch {
        // Sub-agent scopes: "subagent:{agentId}:..." or "self-spawn:{agentId}:..."
        agentId = scope.split(":")[1] ?? "unknown";
      }
    }

    const baseConfig: AgentConfig = deps.allAgents.agents[agentId];
    if (!baseConfig) throw new Error(`Unknown agent: ${agentId}`);
    // Apply per-binding model/effort override without mutating the shared config object.
    const agentConfig: AgentConfig =
      bindingOverride.model || bindingOverride.effort
        ? {
            ...baseConfig,
            ...(bindingOverride.model ? { model: bindingOverride.model } : {}),
            ...(bindingOverride.effort ? { effort: bindingOverride.effort } : {}),
          }
        : baseConfig;

    // ── Concurrency slot ──
    await deps.gate.acquire(scope);

    try {
      // ── Resolve workspace paths ──
      // host_user agents: Claude runs as that OS user (sudo_user for /sudo),
      // cwd = the user's home, workspace added with --add-dir.
      const runAs = agentConfig.sandboxed ? undefined : resolveRunAs(agentConfig, !!meta.sudo);
      const isInline = (agentConfig.inline || meta.forceParentCwd) && meta.parentCwd;
      const hostAgentCwd = isInline
        ? meta.parentCwd!
        : runAs?.workspace ?? resolve(deps.agentsDir, agentId);

      // Inline children run as a fresh query() inside the parent's already-running
      // worker container. Runtime characteristics (sandboxed, cwd, mounts, env)
      // follow the parent — only model/system prompt/permissions come from the
      // child's own config. If the parent worker isn't alive, fall back to a
      // standalone child worker via ensure() below.
      const parentWorkerUrl = isInline && meta.parentAgentId
        ? deps.workerManager.lookupExisting(meta.parentAgentId)
        : undefined;
      const parentConfig = parentWorkerUrl && meta.parentAgentId
        ? deps.allAgents.agents[meta.parentAgentId]
        : undefined;
      const effectiveSandboxed = parentConfig?.sandboxed ?? agentConfig.sandboxed ?? false;

      // sdkCwd: platform root, or the run-as user's home (both avoid the SDK's
      // Mjz() block on <cwd>/.claude/skills/ for the workspace's skills).
      const sdkCwd = effectiveSandboxed ? "/workspace" : runAs?.cwd ?? deps.platformRoot;
      const sdkAddDirs = effectiveSandboxed ? [] : runAs ? [...new Set([...runAs.addDirs, hostAgentCwd])] : [hostAgentCwd];
      // agentCwd as seen inside worker (for permission rules and callbacks)
      const workerAgentCwd = effectiveSandboxed ? "/workspace" : hostAgentCwd;

      // ── Ensure worker is running (or reuse parent's for inline children) ──
      const workerUrl = parentWorkerUrl
        ?? await deps.workerManager.ensure(agentId, agentConfig, scope);
      if (parentWorkerUrl) {
        sessionLog(
          `[session] inline ${agentId} → reusing parent ${meta.parentAgentId} worker ${parentWorkerUrl}`,
        );
      }

      // ── Create callback session ──
      const callbackToken = randomUUID();
      createCallbackSession(callbackToken, {
        callbackToken,
        agentId,
        scope,
        userId: meta.userId,
        userPlatform: meta.userPlatform,
        agentConfig,
        agentCwd: workerAgentCwd,
        platformRoot: deps.platformRoot,
        askApproval: meta.askApproval,
        askQuestions: meta.askQuestions,
        hops: meta.hops ?? 0,
        platformConfig: deps.platform,
        allAgents: deps.allAgents,
        agentsDir: deps.agentsDir,
        workerUrl,
      });

      // ── Build worker environment ──
      let proxyToken: string | undefined;
      let workerEnv: Record<string, string> = {
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        MAX_THINKING_TOKENS: agentConfig.model?.includes("opus") ? "128000" : "64000",
        REDIS_URL: deps.redisUrl,
        // Safety margin for slow MCP server cold-starts (e.g. chrome-devtools-mcp
        // connecting to Chrome). The SDK drops MCP servers that don't finish
        // initializing within this window; the default is too short for a
        // browser-attaching server on a loaded container.
        MCP_TIMEOUT: "60000",
      };

      if (deps.proxy && agentConfig.sandboxed) {
        const caCertPath = "/certs/proxy-ca.crt";
        workerEnv = {
          ...workerEnv,
          HTTP_PROXY: `http://${deps.proxy.host}:10255`,
          HTTPS_PROXY: `http://${deps.proxy.host}:10255`,
          NO_PROXY: "localhost,127.0.0.1,host.docker.internal,platform.claude.com,console.anthropic.com",
          NODE_EXTRA_CA_CERTS: caCertPath,
          CURL_CA_BUNDLE: caCertPath,
          REQUESTS_CA_BUNDLE: caCertPath,
          SSL_CERT_FILE: caCertPath,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          PYTHONIOENCODING: "utf-8",
          ANTHROPIC_CUSTOM_HEADERS: [
            `X-Stockade-Agent: ${agentId}`,
            `X-Stockade-Scope: ${scope}`,
          ].join("\n"),
        };

        if (agentConfig.credentials?.length) {
          try {
            const tokenRes = await fetch(`${onHost(deps.proxy.gatewayUrl)}/token`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: AbortSignal.timeout(3_000),
              body: JSON.stringify({
                agentId,
                credentials: agentConfig.credentials,
                storeKeys: agentConfig.store_keys,
              }),
            });
            if (tokenRes.ok) {
              const data = (await tokenRes.json()) as { token: string };
              proxyToken = data.token;
              workerEnv.APW_GATEWAY = deps.proxy.gatewayUrl;
              workerEnv.APW_TOKEN = data.token;

              const credentialEnvMap: Record<string, string> = {
                "tavily-api-key": "TAVILY_API_KEY",
              };
              for (const credKey of agentConfig.credentials) {
                const envVar = credentialEnvMap[credKey];
                if (envVar && !workerEnv[envVar]) {
                  try {
                    const refRes = await fetch(
                      `${onHost(deps.proxy.gatewayUrl)}/gateway/reveal/${credKey}`,
                      {
                        headers: { Authorization: `Bearer ${data.token}` },
                        signal: AbortSignal.timeout(5_000),
                      },
                    );
                    if (refRes.ok) {
                      const refData = (await refRes.json()) as { value: string };
                      workerEnv[envVar] = refData.value;
                    }
                  } catch { /* non-fatal */ }
                }
              }
            }
          } catch { /* proxy not running — continue without credentials */ }
        }
      }

      if (isInline) {
        workerEnv.AGENT_WORKSPACE = hostAgentCwd;
      }

      if (runAs) {
        // The bus address is the worker's business, not the agent's.
        delete workerEnv.REDIS_URL;
        // The persona (workspace CLAUDE.md) comes in through --add-dir.
        workerEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
        workerEnv.AGENT_WORKSPACE = hostAgentCwd;
        if (agentConfig.host_user?.shared_dir) workerEnv.SHARED_DIR = agentConfig.host_user.shared_dir;
      }

      // ── Build system prompt + SDK settings ──
      const hasProxyConfig = !!(deps.proxy && agentConfig.credentials?.length);
      const systemPrompt = buildSystemPrompt(
        agentConfig,
        hasProxyConfig,
        deps.allAgents,
        deps.schedulerEnabled,
      );
      const memoryDir = deps.workerManager.resolveMemoryPath(agentId, agentConfig);
      // Sudo sessions also tell the auto-mode classifier this session has root.
      const sdkSettings = buildSessionSdkSettings(
        agentConfig,
        agentId,
        memoryDir,
        !!agentConfig.inline && !!isInline,
        runAs?.sudo ? runAs.user : undefined,
      );

      // ── Resume: look up existing SDK session ID ──
      const sdkSessionId = meta.noSession ? null : deps.getSessionId(scope);

      // A conversation switched with /sudo moves between OS users: move its transcript to the
      // user this session runs as (one transcript per conversation, never two drifting copies).
      if (runAs && sdkSessionId) {
        let other: ReturnType<typeof resolveRunAs> | undefined;
        try { other = resolveRunAs(agentConfig, !runAs.sudo); } catch { /* no sudo user */ }
        if (other) {
          // A failed hand-over must not silently resume an older copy (state drift): fail loudly.
          const r = await syncTranscript(sdkSessionId, runAs, [other]).catch((err) => {
            deleteCallbackSession(callbackToken);
            throw new Error(`Couldn't hand this conversation over to ${runAs.user} (${err instanceof Error ? err.message : String(err)}). Try again, or /new to start fresh.`);
          });
          if (r === "moved") sessionLog(`[session] transcript ${sdkSessionId.slice(0, 8)} moved to ${runAs.user}`);
        }
      }

      // ── POST /sessions to worker ──
      // In Redis mode the worker subscribes to stockade:msg:{scope} for messages
      // and publishes events to stockade:evt:{scope}. No SSE subscription needed.
      // The callback URL must be reachable from inside the worker. Inline children
      // run in the parent's container, so we follow the parent's container-vs-host
      // setting (effectiveSandboxed) — not the child's standalone config.
      const orchestratorUrl = effectiveSandboxed
        ? deps.orchestratorCallbackUrl.replace("localhost", "host.docker.internal")
        : deps.orchestratorCallbackUrl;

      let workerSessionId: string;
      try {
        const sessRes = await fetch(`${workerUrl}/sessions`, {
          method: "POST",
          headers: workerHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            prompt: "",           // No initial prompt — messages come via Redis
            systemPrompt,
            tools: agentConfig.tools?.filter((t) => t !== "Agent"),
            disallowedTools: [
              ...platformDisallowedTools(agentConfig),
              ...(agentConfig.disallowed_tools ?? []),
            ],
            model: agentConfig.model,
            sessionId: sdkSessionId ?? undefined,
            maxTurns: agentConfig.max_turns ?? 200,
            effort: agentConfig.effort,
            scope,
            cwd: sdkCwd,
            addDir: sdkAddDirs.length ? sdkAddDirs : undefined,
            env: workerEnv,
            orchestratorUrl,
            callbackToken,
            sdkSettings,
            peers: canUsePeers(scope),
            redisMode: true,
            ...(runAs ? { runAs: { user: runAs.user, home: runAs.home, ...(runAs.uid !== undefined ? { uid: runAs.uid } : {}) } } : {}),
            ...(agentConfig.permission_mode ? { permissionMode: agentConfig.permission_mode } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!sessRes.ok) {
          throw new Error(`Worker returned ${sessRes.status}: ${await sessRes.text()}`);
        }

        ({ workerSessionId } = await sessRes.json() as { workerSessionId: string });
      } catch (err) {
        deleteCallbackSession(callbackToken);
        deps.gate.release(scope);
        if (proxyToken && deps.proxy) {
          this.revokeProxyToken(proxyToken).catch(() => {});
        }
        throw err;
      }

      // Update callback session with the worker session ID
      updateCallbackSession(callbackToken, { workerSessionId, workerUrl });

      const session: ManagedSession = {
        scope,
        agentId,
        callbackToken,
        workerUrl,
        workerSessionId,
        agentCwd: hostAgentCwd,
        // Inline children inherit the parent's container/host setting.
        sandboxed: effectiveSandboxed,
        proxyToken,
        sdkSessionId: sdkSessionId ?? null,
        isolated: !!meta.ephemeral,
        sudo: !!meta.sudo,
        idleTimer: this.startIdleTimer(scope),
      };

      this.sessions.set(scope, session);

      // Persist to Redis (best-effort, for crash recovery)
      deps.bus.createSession(scope, {
        scope,
        agentId,
        callbackToken,
        workerUrl,
        sdkSessionId: sdkSessionId ?? undefined,
        proxyToken,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        state: "active",
      }).catch(() => {});

      sessionLog(
        `[session] created ${scope.slice(0, 40)} agent=${agentId} ` +
        `worker=${workerSessionId.slice(0, 8)}${runAs ? ` as=${runAs.user}` : ""}`,
      );
      return session;
    } catch (err) {
      deps.gate.release(scope);
      throw err;
    }
  }

  private startIdleTimer(scope: string): ReturnType<typeof setTimeout> {
    const ttlMs = this.deps.bus.sessionIdleTimeoutSec * 1000;
    return setTimeout(() => {
      this.closeSession(scope, "idle_timeout").catch((err) =>
        console.error(`[session] idle timeout cleanup failed for ${scope}:`, err)
      );
    }, ttlMs);
  }

  private async revokeProxyToken(token: string | undefined): Promise<void> {
    if (!token || !this.deps.proxy) return;
    await fetch(`${onHost(this.deps.proxy.gatewayUrl)}/token/${token}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  }

  private async deleteWorkerSession(workerUrl: string, workerSessionId: string): Promise<void> {
    await fetch(`${workerUrl}/sessions/${workerSessionId}`, {
      method: "DELETE",
      headers: workerHeaders(),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
}
