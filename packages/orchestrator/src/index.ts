import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadConfig } from "./config.js";
import { resolveAgent } from "./router.js";
import { checkAccess, buildPermissionHook } from "./rbac.js";
import { initSessionsTable, getSessionId, setSessionId, deleteSession } from "./sessions.js";
import { dispatch, type DispatchContext } from "./dispatcher.js";
import { TerminalAdapter } from "./channels/terminal.js";
import { DiscordAdapter } from "./channels/discord.js";
import { ContainerManager, DockerClient, DispatchQueue } from "./containers/index.js";
import { startSchedulerLoop, stopSchedulerLoop } from "./scheduler/index.js";
import type { ChannelMessage, AskApprovalFn, ApprovalChannel } from "./types.js";
import { buildGatedAskApproval, resolveEffectivePermissions } from "./gatekeeper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");

// 0. Load .env from config dir
const envPath = resolve(projectRoot, "config/.env");
loadEnv({ path: envPath });

// 1. Load config (paths resolved relative to project root)
const configDir = resolve(projectRoot, "config");
const config = loadConfig(configDir, projectRoot);
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

// Create per-agent directories
for (const agentId of Object.keys(config.agents.agents)) {
  mkdirSync(resolve(paths.agents_dir, agentId), { recursive: true });
}

console.log(`[paths] data_dir=${paths.data_dir}`);
console.log(`[paths] agents_dir=${paths.agents_dir}`);

// 2. Set up sessions DB
const db = new Database(paths.sessions_db);
initSessionsTable(db);

// 3. Set up container manager (if containers config is present)
let containerManager: ContainerManager | undefined;

if (config.platform.containers) {
  const docker = new DockerClient();
  const proxyGatewayUrl = `http://${config.platform.containers.proxy_host}:10256`;

  containerManager = new ContainerManager(
    docker,
    config.platform.containers,
    proxyGatewayUrl,
    paths.data_dir
  );

  // Ensure Docker network exists
  const network = config.platform.containers.network;
  const exists = await docker.networkExists(network);
  if (!exists) {
    await docker.createNetwork(network);
    console.log(`[containers] Created Docker network: ${network}`);
  }

  // Clean up orphaned containers from a previous run
  await containerManager.cleanupOrphans();
  console.log("[containers] Container manager initialized");
}

// 3b. Set up dispatch queue (concurrency control)
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
      // Use a separate scope so each agent gets its own session
      effectiveScope = `${scope}:agent:${targetAgentId}`;
    }
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) {
    return `Unknown agent: ${agentId}`;
  }

  const sessionId = getSessionId(db, effectiveScope);
  const agentCwd = resolve(paths.agents_dir, agentId);
  // When gatekeeper is enabled, agents without explicit permissions
  // get ["ask:*"] so every tool invocation passes through gatekeeper review.
  const effectivePermissions = resolveEffectivePermissions(
    agentConfig.permissions,
    config.platform.gatekeeper,
  );

  const permissionHook = buildPermissionHook(
    userId,
    userPlatform,
    config.platform,
    effectivePermissions,
    agentCwd,
    paths.data_dir,
    askApproval,
  );

  const context: DispatchContext = {
    allAgents: config.agents,
    platform: config.platform,
    userId,
    userPlatform,
    agentsDir: paths.agents_dir,
    platformRoot: paths.data_dir,
    askApproval,
    containerManager,
  };

  const attachments = (pending.meta?.attachments as import("./types.js").ChannelAttachment[] | undefined);
  const result = await dispatch(
    agentId,
    { scope, content: messageText, userId, platform: userPlatform, attachments },
    agentConfig,
    sessionId,
    permissionHook,
    context,
    containerManager
  );

  setSessionId(db, effectiveScope, result.sessionId);
  return result.result;
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
const gatekeeperAgentConfig = config.platform.gatekeeper?.enabled
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
  console.log("Terminal channel started");
}

if (config.platform.channels.discord?.enabled) {
  const adapter = new DiscordAdapter(config.platform.channels.discord, {
    onMessage: handleMessage,
    onSessionReset: (scope) => deleteSession(db, scope),
    agents: config.agents,
  });
  await adapter.start();
  console.log("Discord channel started");
}

// 6. Graceful shutdown
async function shutdown() {
  // Stop accepting new work
  dispatchQueue.shutdown();
  stopSchedulerLoop();

  if (containerManager) {
    console.log("[containers] Shutting down all containers...");
    await containerManager.shutdownAll();
  }
  db.close();
  releaseLock();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
