import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadConfig } from "./config.js";
import { resolveAgent } from "./router.js";
import { checkAccess } from "./rbac.js";
import { initSessionsTable, getSessionId, setSessionId, deleteSession } from "./sessions.js";
import { dispatch, type DispatchContext } from "./dispatcher.js";
import { TerminalAdapter } from "./channels/terminal.js";
import { DiscordAdapter } from "./channels/discord.js";
import { ContainerManager, DockerClient, DispatchQueue } from "./containers/index.js";
import { HostWorkerManager } from "./workers/host.js";
import { startCallbackServer, CALLBACK_PORT } from "./api/server.js";
import { getCallbackSession } from "./api/sessions.js";
import {
  startSchedulerLoop,
  stopSchedulerLoop,
  SQLiteTaskStore,
  initSchedulerTables,
} from "./scheduler/index.js";
import type { ScheduledTask } from "./scheduler/types.js";
import type { ChannelMessage, AskApprovalFn, ApprovalChannel } from "./types.js";
import { buildGatedAskApproval, resolveEffectivePermissions } from "./gatekeeper.js";
import { watchConfigFiles } from "./watch.js";
import { syncAgentSkills } from "./skills.js";
import type { WorkerManager } from "./workers/index.js";

import { PLATFORM_HOME } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");

// 0. Load .env from platform home (~/.stockade/.env)
const envPath = resolve(PLATFORM_HOME, ".env");
loadEnv({ path: envPath });

// 1. Load config from platform home, resolve repo-relative paths against project root
let config = loadConfig(PLATFORM_HOME, projectRoot);
const paths = config.platform.paths!;

// Ensure data directories exist
mkdirSync(paths.data_dir, { recursive: true });

// ── Process lock ────────────────────────────────────────────────
// Prevent multiple orchestrator instances from running simultaneously.
const lockFile = resolve(paths.data_dir, "orchestrator.lock");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence without killing
    return true;
  } catch {
    return false;
  }
}

if (existsSync(lockFile)) {
  const existingPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
  if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
    console.error(`[lock] Another orchestrator is already running (PID ${existingPid}). Exiting.`);
    process.exit(1);
  }
  // Stale lock — previous process died without cleanup
  console.log(`[lock] Removing stale lock (PID ${existingPid} is dead)`);
}

writeFileSync(lockFile, String(process.pid), "utf-8");
console.log(`[lock] Acquired lock (PID ${process.pid})`);

function releaseLock() {
  try {
    // Only remove if it's still our lock
    if (existsSync(lockFile)) {
      const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
      if (pid === process.pid) {
        unlinkSync(lockFile);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
// ────────────────────────────────────────────────────────────────
mkdirSync(paths.agents_dir, { recursive: true });
mkdirSync(paths.containers_dir, { recursive: true });
mkdirSync(paths.logs_dir, { recursive: true });

// Create per-agent directories and sync skills
for (const agentId of Object.keys(config.agents.agents)) {
  mkdirSync(resolve(paths.agents_dir, agentId), { recursive: true });
}
syncAgentSkills(config.agents, paths.agents_dir);

console.log(`[paths] data_dir=${paths.data_dir}`);
console.log(`[paths] agents_dir=${paths.agents_dir}`);

// 2. Set up sessions DB
const db = new Database(paths.sessions_db);
initSessionsTable(db);
initSchedulerTables(db);
const taskStore = new SQLiteTaskStore(db);

// D. Load cached scopes from previous restart (if any)
const activeScopesFile = resolve(paths.data_dir, "active-scopes.json");
if (existsSync(activeScopesFile)) {
  try {
    const cachedScopes = JSON.parse(readFileSync(activeScopesFile, "utf-8")) as string[];
    console.log(`[restart] Resuming ${cachedScopes.length} active scope(s)`);
    unlinkSync(activeScopesFile);
  } catch {
    // Best-effort — ignore malformed cache file
  }
}

// 3. Set up worker managers

// Host worker manager — manages child processes for non-sandboxed agents
const hostWorkerManager = new HostWorkerManager(paths.agents_dir, paths.logs_dir);

// Container manager — manages Docker containers for sandboxed agents (optional)
let containerManager: ContainerManager | undefined;

if (config.platform.containers) {
  const docker = new DockerClient();
  const proxyGatewayUrl = `http://${config.platform.containers.proxy_host}:10256`;

  containerManager = new ContainerManager(
    docker,
    config.platform.containers,
    proxyGatewayUrl,
    paths.data_dir,
    paths.logs_dir,
    paths.agents_dir,
  );

  const network = config.platform.containers.network;
  const exists = await docker.networkExists(network);
  if (!exists) {
    await docker.createNetwork(network);
    console.log(`[containers] Created Docker network: ${network}`);
  }

  await containerManager.cleanupOrphans();
  console.log("[containers] Container manager initialized");
}

// Composite WorkerManager — routes to host or container based on agentConfig.sandboxed
const workerManager: WorkerManager = {
  async ensure(agentId, agentConfig, scope) {
    if (agentConfig.sandboxed && containerManager) {
      return containerManager.ensure(agentId, agentConfig, scope);
    }
    return hostWorkerManager.ensure(agentId, agentConfig, scope);
  },
  async restart(agentId, agentConfig) {
    if (agentConfig.sandboxed && containerManager) {
      return containerManager.restart(agentId, agentConfig);
    }
    return hostWorkerManager.restart(agentId, agentConfig);
  },
  async shutdownAll() {
    await Promise.all([
      hostWorkerManager.shutdownAll(),
      containerManager?.shutdownAll(),
    ]);
  },
  async cleanupOrphans() {
    await Promise.all([
      hostWorkerManager.cleanupOrphans(),
      containerManager?.cleanupOrphans(),
    ]);
  },
  resolveMemoryPath(agentId, agentConfig) {
    if (agentConfig.sandboxed && containerManager) {
      return containerManager.resolveMemoryPath(agentId, agentConfig);
    }
    return hostWorkerManager.resolveMemoryPath(agentId, agentConfig);
  },
};

// 3b. Start orchestrator callback server (port 7420)
// Workers call back here for permission checks and agent MCP tool invocations.
const orchestratorCallbackUrl = `http://localhost:${CALLBACK_PORT}`;

const stopCallbackServer = startCallbackServer(
  workerManager,
  (token) => {
    const ctx = getCallbackSession(token);
    if (!ctx) return null;
    const proxyConfig = config.platform.containers ? {
      gatewayUrl: `http://${config.platform.containers.proxy_host}:10256`,
      host: config.platform.containers.proxy_host,
      caCertPath: resolve(projectRoot, config.platform.containers.proxy_ca_cert),
    } : undefined;
    return {
      allAgents: config.agents,
      platform: config.platform,
      userId: ctx.userId,
      userPlatform: ctx.userPlatform,
      agentsDir: paths.agents_dir,
      platformRoot: paths.data_dir,
      askApproval: ctx.askApproval,
      workerManager,
      proxy: proxyConfig,
      orchestratorCallbackUrl,
      onBackgroundComplete: (scope, text, meta) => {
        console.log(`[agent-mcp] background completion for scope=${scope.slice(0, 40)} — re-dispatching via queue`);
        dispatchQueue.enqueue(scope, text, { userId: meta.userId, userPlatform: meta.userPlatform, askApproval: meta.askApproval })
          .then((result) => {
            const platform = scope.split(":")[0];
            const sender = channelSenders.get(platform);
            if (sender) {
              return sender(scope, result);
            }
          })
          .catch((err: unknown) => {
            console.error(`[agent-mcp] background completion dispatch failed for scope=${scope.slice(0, 40)}:`, err);
          });
      },
    };
  },
  taskStore,
);

// 3c. Set up dispatch queue (concurrency control)
const maxConcurrent = config.platform.containers?.max_concurrent ?? 5;
const dispatchQueue = new DispatchQueue({ maxConcurrent });

// Wire processMessage: dispatches a single message for a scope
dispatchQueue.setProcessMessageFn(async (agentKey, pending) => {
  try {
    const result = await doDispatch(agentKey, pending);
    pending.resolve(result);
    return true;
  } catch (err) {
    pending.resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
});

/**
 * Perform the actual dispatch for a scope.
 * Uses the caller's identity from pending.meta when available,
 * falls back to "system" for scheduler-originated messages.
 */
async function doDispatch(scope: string, pending: { text: string; meta?: Record<string, unknown> }): Promise<string> {
  const userId = (pending.meta?.userId as string) ?? "system";
  const userPlatform = (pending.meta?.userPlatform as string) ?? "internal";
  const askApproval = pending.meta?.askApproval as AskApprovalFn | undefined;
  // noSession: isolated scheduled tasks — don't resume or overwrite the channel session
  const noSession = (pending.meta?.noSession as boolean) ?? false;

  // Handle /agent:<id> routing prefix (from Discord /agent slash command)
  let messageText = pending.text;
  let agentId = resolveAgent(scope, config.platform);
  let effectiveScope = scope;

  const agentPrefixMatch = messageText.match(/^\/agent:(\S+)\s+([\s\S]*)$/);
  if (agentPrefixMatch) {
    const targetAgentId = agentPrefixMatch[1];
    if (config.agents.agents[targetAgentId]) {
      agentId = targetAgentId;
      messageText = agentPrefixMatch[2];
      effectiveScope = `${scope}:agent:${targetAgentId}`;
    }
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) {
    return `Unknown agent: ${agentId}`;
  }

  const sessionId = noSession ? null : getSessionId(db, effectiveScope);

  // Build proxy config for credential injection
  const proxyConfig = config.platform.containers ? {
    gatewayUrl: `http://${config.platform.containers.proxy_host}:10256`,
    host: config.platform.containers.proxy_host,
    caCertPath: resolve(projectRoot, config.platform.containers.proxy_ca_cert),
  } : undefined;

  const context: DispatchContext = {
    allAgents: config.agents,
    platform: config.platform,
    userId,
    userPlatform,
    agentsDir: paths.agents_dir,
    platformRoot: paths.data_dir,
    askApproval,
    workerManager,
    proxy: proxyConfig,
    orchestratorCallbackUrl,
    schedulerEnabled: true,
  };

  const attachments = (pending.meta?.attachments as import("./types.js").ChannelAttachment[] | undefined);

  const result = await dispatch(
    agentId,
    { scope: effectiveScope, content: messageText, userId, platform: userPlatform, attachments },
    agentConfig,
    sessionId,
    undefined, // RBAC now handled via HTTP callback in worker's PreToolUse hook
    context,
  );

  if (!noSession) {
    setSessionId(db, effectiveScope, result.sessionId);
  }
  return result.result;
}

// 3d. Channel sender registry — populated when adapters start
// Used by scheduler to deliver task results back to the originating channel.
const channelSenders = new Map<string, (scope: string, text: string) => Promise<void>>();

/**
 * Execute a scheduled task: dispatch to the agent and deliver the result
 * back to the channel the task was created in.
 */
async function executeTask(task: ScheduledTask): Promise<string> {
  const result = await dispatchQueue.enqueue(task.scope, task.prompt, {
    userId: task.userId,
    userPlatform: task.userPlatform,
    noSession: task.context_mode === "isolated",
  });

  // Deliver result back to the originating channel
  const platform = task.scope.split(":")[0];
  const sender = channelSenders.get(platform);
  if (sender) {
    sender(task.scope, result).catch((err: unknown) =>
      console.error(`[scheduler] Failed to deliver result for task ${task.id}:`, err)
    );
  }

  return result;
}

// 4. Define handleMessage callback — routes through the dispatch queue
async function handleMessage(msg: ChannelMessage, approvalChannel?: ApprovalChannel): Promise<string> {
  // Check for /agent:<id> prefix to determine target agent for RBAC + scope
  let agentId = resolveAgent(msg.scope, config.platform);
  let enqueueScope = msg.scope;
  const agentPrefixMatch = msg.content.match(/^\/agent:(\S+)\s/);
  if (agentPrefixMatch && config.agents.agents[agentPrefixMatch[1]]) {
    agentId = agentPrefixMatch[1];
    // Use a separate scope so this doesn't inject into the default agent's session
    enqueueScope = `${msg.scope}:agent:${agentId}`;
  }

  if (!checkAccess(msg.userId, msg.platform, agentId, config.platform)) {
    return "Access denied.";
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) {
    return `Unknown agent: ${agentId}`;
  }

  // Build the AskApprovalFn from channel callbacks + gatekeeper wrapping.
  // Gatekeeper logic lives here (orchestrator layer), not in the channels.
  let askApproval: AskApprovalFn | undefined;
  if (approvalChannel) {
    const gk = config.platform.gatekeeper;
    if (gk?.enabled && gatekeeperAgentConfig) {
      askApproval = buildGatedAskApproval(approvalChannel, gk, gatekeeperAgentConfig);
    } else {
      // No gatekeeper — channel's askUser is the AskApprovalFn directly
      askApproval = (tool, input) => approvalChannel.askUser(tool, input);
    }
  }

  // Enqueue through the dispatch queue — serializes per-scope,
  // respects global concurrency, handles retry with backoff.
  // User identity + HITL callback carried via meta so doDispatch uses them.
  return dispatchQueue.enqueue(enqueueScope, msg.content, {
    userId: msg.userId,
    userPlatform: msg.platform,
    askApproval,
    attachments: msg.attachments,
  });
}

// 5. Start channels
// Resolve gatekeeper agent config (if gatekeeper is enabled)
let gatekeeperAgentConfig = config.platform.gatekeeper?.enabled
  ? config.agents.agents[config.platform.gatekeeper.agent]
  : undefined;

if (config.platform.gatekeeper?.enabled) {
  if (gatekeeperAgentConfig) {
    console.log(
      `[gatekeeper] Enabled — agent="${config.platform.gatekeeper.agent}" ` +
      `model="${gatekeeperAgentConfig.model}" ` +
      `auto_approve_risk="${config.platform.gatekeeper.auto_approve_risk ?? "low"}"`,
    );
  } else {
    console.error(
      `[gatekeeper] WARNING: agent "${config.platform.gatekeeper.agent}" not found in agents config — gatekeeper disabled`,
    );
  }
}

if (config.platform.channels.terminal?.enabled) {
  const adapter = new TerminalAdapter(
    config.platform.channels.terminal,
    handleMessage,
  );
  adapter.start();
  channelSenders.set("terminal", (scope, text) => adapter.send(scope, text));
  console.log("Terminal channel started");
}

if (config.platform.channels.discord?.enabled) {
  const adapter = new DiscordAdapter(config.platform.channels.discord, {
    onMessage: handleMessage,
    onSessionReset: (scope) => deleteSession(db, scope),
    agents: config.agents,
  });
  await adapter.start();
  channelSenders.set("discord", (scope, text) => adapter.send(scope, text));
  console.log("Discord channel started");
}

// 5b. Start the scheduler loop
const schedulerConfig = config.platform.scheduler ?? { poll_interval_ms: 60_000, timezone: "UTC" };
startSchedulerLoop({ store: taskStore, config: schedulerConfig, executeTask });
console.log(`[scheduler] Started (poll every ${schedulerConfig.poll_interval_ms}ms, tz=${schedulerConfig.timezone})`);

// 6. Hot reload config on file changes
// Agent definitions, RBAC, gatekeeper, and .env are reloaded live.
// Channels, container manager, and paths are NOT reloaded (require restart).
// Track serialized agent configs to diff on reload — only restart workers whose config changed.
const prevAgentConfigs = new Map<string, string>();
for (const [id, cfg] of Object.entries(config.agents.agents)) {
  prevAgentConfigs.set(id, JSON.stringify(cfg));
}
const stopWatch = watchConfigFiles(PLATFORM_HOME, envPath, projectRoot, (next) => {
  config = { agents: next.agents, platform: { ...next.platform, paths: config.platform.paths } };

  // Re-resolve gatekeeper agent config
  gatekeeperAgentConfig = config.platform.gatekeeper?.enabled
    ? config.agents.agents[config.platform.gatekeeper.agent]
    : undefined;

  // Ensure directories exist for any new agents
  for (const agentId of Object.keys(config.agents.agents)) {
    mkdirSync(resolve(paths.agents_dir, agentId), { recursive: true });
  }

  // Re-sync skills (adds/removes junctions based on new config)
  syncAgentSkills(config.agents, paths.agents_dir);

  // Only restart workers whose agent config actually changed (avoids killing active sessions).
  // The config object is small — JSON stringify comparison is sufficient.
  const agentIds = Object.keys(config.agents.agents);
  const changed = agentIds.filter((id) => {
    const prev = prevAgentConfigs.get(id);
    const curr = JSON.stringify(config.agents.agents[id]);
    prevAgentConfigs.set(id, curr);
    return prev !== undefined && prev !== curr;
  });
  // Also track new agents (no restart needed, but store for next diff)
  for (const id of agentIds) {
    if (!prevAgentConfigs.has(id)) {
      prevAgentConfigs.set(id, JSON.stringify(config.agents.agents[id]));
    }
  }
  if (changed.length === 0) {
    console.log("[watch] config reloaded — no agent config changes, skipping worker restarts");
  } else {
    console.log(`[watch] config changed for: ${changed.join(", ")} — restarting`);
    Promise.all(
      changed.map((agentId) => {
        const agentCfg = config.agents.agents[agentId];
        return workerManager.restart(agentId, agentCfg).catch(
          (err: Error) => console.error(`[watch] Worker restart failed for ${agentId}:`, err),
        );
      }),
    ).catch((err) => console.error("[watch] Worker restart after config reload failed:", err));
  }
});

// ── Restart support ─────────────────────────────────────────────
let restartRequested = false;
let restartWatcher: FSWatcher | undefined;

// 7. Graceful shutdown
async function shutdown() {
  // Stop accepting new work
  stopWatch();
  stopCallbackServer();
  dispatchQueue.shutdown();
  stopSchedulerLoop();

  // Clean up restart signal watcher
  if (restartWatcher) {
    restartWatcher.close();
    restartWatcher = undefined;
  }

  console.log("[workers] Shutting down all workers...");
  await workerManager.shutdownAll();

  // Cache active scopes before closing DB (only on restart)
  if (restartRequested) {
    try {
      const rows = db.prepare("SELECT scope FROM sessions").all() as { scope: string }[];
      const scopes = rows.map((r) => r.scope);
      writeFileSync(resolve(paths.data_dir, "active-scopes.json"), JSON.stringify(scopes), "utf-8");
      console.log(`[restart] Cached ${scopes.length} active scope(s) for resume`);
    } catch {
      // Best-effort
    }
  }

  db.close();
  releaseLock();
  if (restartRequested) {
    process.exit(75);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 8. Restart signal file watcher
// Watch the data_dir directory (not the signal file itself, which may not exist yet)
const signalFileName = "restart.signal";
restartWatcher = fsWatch(paths.data_dir, (eventType, filename) => {
  if (filename === signalFileName) {
    console.log("[restart] Restart signal received");
    restartRequested = true;
    const signalPath = resolve(paths.data_dir, signalFileName);
    try {
      if (existsSync(signalPath)) {
        unlinkSync(signalPath);
      }
    } catch {
      // Best-effort cleanup
    }
    shutdown().catch((err) => {
      console.error("[restart] Error during shutdown:", err);
      process.exit(75);
    });
  }
});
