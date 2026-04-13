import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadConfig } from "./config.js";
import { resolveAgent } from "./router.js";
import { checkAccess } from "./rbac.js";
import { initSessionsTable, getSessionId, setSessionId, deleteSession } from "./sessions.js";
import type { DispatchContext } from "./dispatcher.js";
import { TerminalAdapter } from "./channels/terminal.js";
import { DiscordAdapter } from "./channels/discord.js";
import { ContainerManager, DockerClient } from "./containers/index.js";
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
import type { ChannelMessage, AskApprovalFn, ApprovalChannel, ChannelResponse, ChannelFile } from "./types.js";
import { buildGatedAskApproval, resolveEffectivePermissions } from "./gatekeeper.js";
// import { watchConfigFiles } from "./watch.js"; // Hot-reload disabled
import { ensurePlatformSkillsDir, migrateSyncedCopies } from "./skills.js";
import type { WorkerManager } from "./workers/index.js";
import { EventBus, ConcurrencyGate, SessionManager, OrchestratorBridge } from "./bus/index.js";

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

// Create per-agent directories, ensure platform skills dir, migrate old copies
for (const agentId of Object.keys(config.agents.agents)) {
  mkdirSync(resolve(paths.agents_dir, agentId), { recursive: true });
}
ensurePlatformSkillsDir(paths.data_dir);
migrateSyncedCopies(paths.agents_dir);
const sharedDir = resolve(paths.data_dir, "shared");
mkdirSync(sharedDir, { recursive: true });

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

// Host worker manager — manages child processes for non-sandboxed agents.
// Pass REDIS_URL so workers initialize their Redis bridge at startup.
const hostWorkerManager = new HostWorkerManager(
  paths.agents_dir,
  paths.logs_dir,
  {
    ...(config.platform.redis ? { REDIS_URL: config.platform.redis.url } : {}),
    SHARED_DIR: sharedDir,
  },
);

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
    config.platform.redis?.url,
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

// 3b. Set up Redis event bus + session manager + orchestrator bridge
const redisConfig = config.platform.redis;
if (!redisConfig) {
  console.error("[bus] FATAL: redis section required in config.yaml — add `redis: { url: \"redis://localhost:6379\" }`");
  process.exit(1);
}

const bus = new EventBus({
  redisUrl: redisConfig.url,
  sessionIdleTimeoutSec: redisConfig.session_idle_timeout_sec,
});

const maxConcurrent = config.platform.containers?.max_concurrent ?? 5;
const gate = new ConcurrencyGate(maxConcurrent);

const proxyConfig = config.platform.containers ? {
  gatewayUrl: `http://${config.platform.containers.proxy_host}:10256`,
  host: config.platform.containers.proxy_host,
  caCertPath: resolve(projectRoot, config.platform.containers.proxy_ca_cert),
} : undefined;

const orchestratorCallbackUrl = `http://localhost:${CALLBACK_PORT}`;

const sessionManager = new SessionManager({
  bus,
  gate,
  allAgents: config.agents,
  platform: config.platform,
  agentsDir: paths.agents_dir,
  platformRoot: paths.data_dir,
  workerManager,
  proxy: proxyConfig,
  orchestratorCallbackUrl,
  schedulerEnabled: true,
  redisUrl: redisConfig.url,
  getSessionId: (scope) => getSessionId(db, scope),
  setSessionId: (scope, id) => setSessionId(db, scope, id),
});

const bridge = new OrchestratorBridge(bus, sessionManager);
await bridge.start();
console.log(`[bus] Redis event bus started (url=${redisConfig.url})`);

// 3c. Start orchestrator callback server (port 7420)
// Workers call back here for permission checks and agent MCP tool invocations.
const stopCallbackServer = startCallbackServer(
  workerManager,
  bridge,
  (token) => {
    const ctx = getCallbackSession(token);
    if (!ctx) return null;
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
    };
  },
  taskStore,
);

// 3d. Channel sender registry — populated when adapters start
// Used by scheduler to deliver task results back to the originating channel.
const channelSenders = new Map<string, (scope: string, text: string, files?: ChannelFile[]) => Promise<void>>();

/**
 * Execute a scheduled task: dispatch to the agent and deliver the result
 * back to the channel the task was created in.
 */
async function executeTask(task: ScheduledTask): Promise<string> {
  const response = await bridge.sendAndWait(task.scope, task.prompt, {
    userId: task.userId,
    userPlatform: task.userPlatform,
    noSession: task.context_mode === "isolated",
  });

  // Deliver result back to the originating channel
  const platform = task.scope.split(":")[0];
  const sender = channelSenders.get(platform);
  if (sender) {
    sender(task.scope, response.text, response.files).catch((err: unknown) =>
      console.error(`[scheduler] Failed to deliver result for task ${task.id}:`, err)
    );
  }

  return response.text;
}

// 4. Define handleMessage callback — routes through the Redis event bus
async function handleMessage(msg: ChannelMessage, approvalChannel?: ApprovalChannel): Promise<ChannelResponse> {
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
    return { text: "Access denied." };
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) {
    return { text: `Unknown agent: ${agentId}` };
  }

  // Build the AskApprovalFn from channel callbacks + gatekeeper wrapping.
  // Gatekeeper logic lives here (orchestrator layer), not in the channels.
  let askApproval: AskApprovalFn | undefined;
  if (approvalChannel) {
    const gk = config.platform.gatekeeper;
    if (gk?.enabled && gatekeeperAgentConfig) {
      askApproval = buildGatedAskApproval(approvalChannel, gk, gatekeeperAgentConfig, agentId);
    } else {
      // No gatekeeper — channel's askUser is the AskApprovalFn directly
      askApproval = (tool, input) => approvalChannel.askUser(tool, input, undefined, agentId);
    }
  }

  return bridge.sendAndWait(enqueueScope, msg.content, {
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
  channelSenders.set("terminal", (scope, text, _files?) => adapter.send(scope, text));
  console.log("Terminal channel started");
}

if (config.platform.channels.discord?.enabled) {
  const adapter = new DiscordAdapter(config.platform.channels.discord, {
    onMessage: handleMessage,
    onSessionReset: (scope) => deleteSession(db, scope),
    agents: config.agents,
  });
  await adapter.start();
  channelSenders.set("discord", (scope, text, files?) => adapter.send(scope, text, files));
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
// Hot-reload disabled — restart the process to pick up config changes.
const stopWatch = (() => {}) as () => void;

// ── Restart support ─────────────────────────────────────────────
let restartRequested = false;
const signalFile = resolve(paths.data_dir, "restart.signal");

// Clear any stale signal from a previous run
if (existsSync(signalFile)) unlinkSync(signalFile);

// Poll for restart.signal every 2s
const restartPoller = setInterval(() => {
  if (existsSync(signalFile)) {
    try { unlinkSync(signalFile); } catch { /* best-effort */ }
    console.log("[restart] Signal received — shutting down for restart...");
    restartRequested = true;
    shutdown();
  }
}, 2000);

// 7. Graceful shutdown
async function shutdown() {
  clearInterval(restartPoller);
  // Stop accepting new work
  stopWatch();
  stopCallbackServer();
  stopSchedulerLoop();

  console.log("[bus] Shutting down event bus...");
  await bridge.shutdown();

  if (restartRequested && containerManager) {
    // On restart: keep containers alive so they can be reconnected on startup.
    // - Skip proxy token revocation (container env tokens stay valid)
    // - Stop containers without removing them (docker stop, not rm)
    // Workers' persistent loops are aborted via deleteWorkerSession in closeSession.
    await sessionManager.closeAll({ skipRevoke: true });
    await hostWorkerManager.shutdownAll();
    await containerManager.gracefulShutdown(true);
  } else {
    // On clean exit: full teardown
    await sessionManager.closeAll();
    console.log("[workers] Shutting down all workers...");
    await workerManager.shutdownAll();
  }

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
