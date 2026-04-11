/**
 * Validation entrypoint — starts the orchestrator with terminal-only config
 * for manual feature verification.
 *
 * Usage: npx tsx src/validate.ts
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { loadConfig } from "./config.js";
import { resolveAgent } from "./router.js";
import { checkAccess } from "./rbac.js";
import { initSessionsTable, getSessionId, setSessionId } from "./sessions.js";
import { dispatch, type DispatchContext } from "./dispatcher.js";
import { TerminalAdapter } from "./channels/terminal.js";
import { DispatchQueue } from "./containers/queue.js";
import { HostWorkerManager } from "./workers/host.js";
import { startCallbackServer, CALLBACK_PORT } from "./api/server.js";
import { getCallbackSession } from "./api/sessions.js";
import type { ChannelMessage, ChannelResponse, ApprovalChannel } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");

// Load config from test-terminal fixture
const configDir = resolve(__dirname, "../tests/fixtures/test-terminal");
console.log(`[validate] Loading config from: ${configDir}`);

const config = loadConfig(configDir, projectRoot);
const paths = config.platform.paths!;
console.log(`[validate] Config loaded successfully`);
console.log(`[validate] Agents: ${Object.keys(config.agents.agents).join(", ")}`);
console.log(`[validate] Terminal enabled: ${config.platform.channels.terminal?.enabled}`);
console.log(`[validate] data_dir: ${paths.data_dir}`);

// Set up sessions DB
mkdirSync(paths.data_dir, { recursive: true });
mkdirSync(paths.agents_dir, { recursive: true });
const db = new Database(paths.sessions_db);
initSessionsTable(db);
console.log(`[validate] Sessions DB ready at ${paths.sessions_db}`);

// Set up host worker manager
const hostWorkerManager = new HostWorkerManager(paths.agents_dir, paths.logs_dir);
const orchestratorCallbackUrl = `http://localhost:${CALLBACK_PORT}`;

const stopCallbackServer = startCallbackServer(
  hostWorkerManager,
  null, // no Redis bridge in validate mode
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
      workerManager: hostWorkerManager,
      proxy: undefined,
      orchestratorCallbackUrl,
    };
  },
);

// Set up dispatch queue
const dispatchQueue = new DispatchQueue({ maxConcurrent: 5 });
console.log(`[validate] DispatchQueue ready (maxConcurrent=5)`);

// Define handleMessage callback
async function handleMessage(msg: ChannelMessage, _approvalChannel?: ApprovalChannel): Promise<ChannelResponse> {
  console.log(`[validate] handleMessage: scope=${msg.scope}, userId=${msg.userId}`);

  const agentId = resolveAgent(msg.scope, config.platform);
  console.log(`[validate] Resolved agent: ${agentId}`);

  if (!checkAccess(msg.userId, msg.platform, agentId, config.platform)) {
    console.log(`[validate] Access DENIED for ${msg.userId}`);
    return { text: "Access denied." };
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) return { text: `Unknown agent: ${agentId}` };

  const sessionId = getSessionId(db, msg.scope);
  console.log(`[validate] Session: ${sessionId ?? "(new)"}`);

  const context: DispatchContext = {
    allAgents: config.agents,
    platform: config.platform,
    userId: msg.userId,
    userPlatform: msg.platform,
    agentsDir: paths.agents_dir,
    platformRoot: paths.data_dir,
    workerManager: hostWorkerManager,
    orchestratorCallbackUrl,
  };

  const result = await dispatch(agentId, msg, agentConfig, sessionId, undefined, context);

  setSessionId(db, msg.scope, result.sessionId);
  console.log(`[validate] Response (${result.result.length} chars), session=${result.sessionId}`);
  return { text: result.result };
}

// Start terminal channel
const terminalConfig = config.platform.channels.terminal;
if (terminalConfig?.enabled) {
  const adapter = new TerminalAdapter(terminalConfig, handleMessage);
  adapter.start();
  console.log(`[validate] Terminal channel started — type a message to test\n`);
} else {
  console.error("[validate] Terminal not enabled in config!");
  process.exit(1);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[validate] Shutting down...");
  stopCallbackServer();
  dispatchQueue.shutdown();
  db.close();
  hostWorkerManager.shutdownAll().then(() => process.exit(0));
});
