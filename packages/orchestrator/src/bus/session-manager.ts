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
}

export interface SessionMeta {
  userId: string;
  userPlatform: string;
  askApproval?: AskApprovalFn;
  /** When true: don't resume or persist SDK session (scheduler isolated tasks). */
  noSession?: boolean;
  /** Override agentId (for sub-agents where scope doesn't resolve via router). */
  agentId?: string;
  /** Parent agent's cwd (inline sub-agents share workspace). */
  parentCwd?: string;
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
  proxyToken?: string;
  sdkSessionId: string | null;
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
      // sdkCwd: platform root (avoids SDK Mjz() block on .claude/skills/)
      const sdkCwd = agentConfig.sandboxed ? "/workspace" : deps.platformRoot;
      const sdkAddDirs = agentConfig.sandboxed ? [] : [hostAgentCwd];
      // agentCwd as seen inside worker (for permission rules and callbacks)
      const workerAgentCwd = agentConfig.sandboxed ? "/workspace" : hostAgentCwd;

      // ── Ensure worker is running ──
      const workerUrl = await deps.workerManager.ensure(agentId, agentConfig, scope);

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
      const orchestratorUrl = agentConfig.sandboxed
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
        proxyToken,
        sdkSessionId: sdkSessionId ?? null,
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
