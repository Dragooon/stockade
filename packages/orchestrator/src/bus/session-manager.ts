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
  PlatformConfig,
} from "../types.js";
import type { WorkerManager } from "../workers/index.js";
import {
  createCallbackSession,
  deleteCallbackSession,
  updateCallbackSession,
} from "../api/sessions.js";
import { resolveAgent } from "../router.js";
import {
  buildSystemPrompt,
  buildSdkSettings,
  PLATFORM_DISALLOWED_TOOLS,
} from "../dispatcher.js";
import type { EventBus } from "./event-bus.js";
import type { ConcurrencyGate } from "./concurrency-gate.js";
import { appendLog } from "../log.js";

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
}

export interface SessionMeta {
  userId: string;
  userPlatform: string;
  askApproval?: AskApprovalFn;
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
  async ensureSession(scope: string, meta: SessionMeta): Promise<ManagedSession> {
    const existing = this.sessions.get(scope);
    if (existing) {
      // Refresh idle timer
      clearTimeout(existing.idleTimer);
      existing.idleTimer = this.startIdleTimer(scope);

      // Update identity and HITL callback on the long-lived callback session
      updateCallbackSession(existing.callbackToken, {
        userId: meta.userId,
        userPlatform: meta.userPlatform,
        askApproval: meta.askApproval,
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
    if (meta.agentId) {
      agentId = meta.agentId;
    } else {
      try {
        agentId = resolveAgent(scope, deps.platform);
      } catch {
        // Sub-agent scopes: "subagent:{agentId}:..." or "self-spawn:{agentId}:..."
        agentId = scope.split(":")[1] ?? "unknown";
      }
    }

    const agentConfig: AgentConfig = deps.allAgents.agents[agentId];
    if (!agentConfig) throw new Error(`Unknown agent: ${agentId}`);

    // ── Concurrency slot ──
    await deps.gate.acquire(scope);

    try {
      // ── Resolve workspace paths ──
      const isInline = (agentConfig.inline || meta.forceParentCwd) && meta.parentCwd;
      const hostAgentCwd = isInline
        ? meta.parentCwd!
        : resolve(deps.agentsDir, agentId);

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

      // sdkCwd: platform root (avoids SDK Mjz() block on .claude/skills/)
      const sdkCwd = effectiveSandboxed ? "/workspace" : deps.platformRoot;
      const sdkAddDirs = effectiveSandboxed ? [] : [hostAgentCwd];
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
            const tokenRes = await fetch(`${deps.proxy.gatewayUrl}/token`, {
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
                      `${deps.proxy.gatewayUrl}/gateway/reveal/${credKey}`,
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

      // ── Build system prompt + SDK settings ──
      const hasProxyConfig = !!(deps.proxy && agentConfig.credentials?.length);
      const systemPrompt = buildSystemPrompt(
        agentConfig,
        hasProxyConfig,
        deps.allAgents,
        deps.schedulerEnabled,
      );
      const memoryDir = deps.workerManager.resolveMemoryPath(agentId, agentConfig);
      const sdkSettings = buildSdkSettings(
        agentConfig,
        agentId,
        memoryDir,
        agentConfig.inline && !!isInline,
      );

      // ── Resume: look up existing SDK session ID ──
      const sdkSessionId = meta.noSession ? null : deps.getSessionId(scope);

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "",           // No initial prompt — messages come via Redis
            systemPrompt,
            tools: agentConfig.tools?.filter((t) => t !== "Agent"),
            disallowedTools: [
              ...PLATFORM_DISALLOWED_TOOLS,
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
            redisMode: true,
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
        `worker=${workerSessionId.slice(0, 8)}`,
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
    await fetch(`${this.deps.proxy.gatewayUrl}/token/${token}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  }

  private async deleteWorkerSession(workerUrl: string, workerSessionId: string): Promise<void> {
    await fetch(`${workerUrl}/sessions/${workerSessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
}
