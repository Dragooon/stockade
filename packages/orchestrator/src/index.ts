import { config as loadEnv } from "dotenv";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { loadConfig } from "./config.js";
import { resolveAgent } from "./router.js";
import { checkAccess, buildPermissionHook } from "./rbac.js";
import { initSessionsTable, getSessionId, setSessionId } from "./sessions.js";
import { dispatch, type DispatchContext } from "./dispatcher.js";
import { TerminalAdapter } from "./channels/terminal.js";
import { DiscordAdapter } from "./channels/discord.js";
import type { ChannelMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 0. Load .env from config dir
const envPath = resolve(__dirname, "../../../config/.env");
loadEnv({ path: envPath });

// 1. Load config
const configDir = resolve(__dirname, "../../../config");
const config = loadConfig(configDir);

// 2. Set up sessions DB
const dbPath = resolve(__dirname, "../../../data/sessions.db");
const db = new Database(dbPath);
initSessionsTable(db);

// 3. Define handleMessage callback
async function handleMessage(msg: ChannelMessage): Promise<string> {
  const agentId = resolveAgent(msg.scope, config.platform);

  if (!checkAccess(msg.userId, msg.platform, agentId, config.platform)) {
    return "Access denied.";
  }

  const agentConfig = config.agents.agents[agentId];
  if (!agentConfig) {
    return `Unknown agent: ${agentId}`;
  }

  const sessionId = getSessionId(db, msg.scope);
  const permissionHook = buildPermissionHook(
    msg.userId,
    msg.platform,
    config.platform
  );

  const context: DispatchContext = {
    allAgents: config.agents,
    platform: config.platform,
    userId: msg.userId,
    userPlatform: msg.platform,
  };

  const result = await dispatch(
    agentId,
    msg,
    agentConfig,
    sessionId,
    permissionHook,
    context
  );

  setSessionId(db, msg.scope, result.sessionId);
  return result.result;
}

// 4. Start channels
if (config.platform.channels.terminal?.enabled) {
  const adapter = new TerminalAdapter(
    config.platform.channels.terminal,
    handleMessage
  );
  adapter.start();
  console.log("Terminal channel started");
}

if (config.platform.channels.discord?.enabled) {
  const adapter = new DiscordAdapter(
    config.platform.channels.discord,
    handleMessage
  );
  await adapter.start();
  console.log("Discord channel started");
}

// Graceful shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
