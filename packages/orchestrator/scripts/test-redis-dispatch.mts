/**
 * Live integration test for the Redis dispatch path.
 *
 * Spins up a minimal orchestrator stack (no channels, just the bus):
 *   - EventBus + ConcurrencyGate + SessionManager + OrchestratorBridge
 *   - Callback server on port 7420 (for worker permission callbacks)
 *
 * Then sends a single real message via Redis pub/sub and prints the result.
 *
 * Usage (from repo root):
 *   node --import tsx packages/orchestrator/scripts/test-redis-dispatch.mts
 *
 * Requirements:
 *   - Redis running at localhost:6379
 *   - Claude API credentials in ~/.claude/.credentials.json
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { loadConfig, PLATFORM_HOME } from "../src/config.js";
import { initSessionsTable, getSessionId, setSessionId } from "../src/sessions.js";
import { HostWorkerManager } from "../src/workers/host.js";
import { EventBus } from "../src/bus/event-bus.js";
import { ConcurrencyGate } from "../src/bus/concurrency-gate.js";
import { SessionManager } from "../src/bus/session-manager.js";
import { OrchestratorBridge } from "../src/bus/orchestrator-bridge.js";
import { startCallbackServer, CALLBACK_PORT } from "../src/api/server.js";
import { getCallbackSession } from "../src/api/sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");  // repo root

// ── Config ────────────────────────────────────────────────────────────────

const config = loadConfig(PLATFORM_HOME, projectRoot);
const paths = config.platform.paths!;

mkdirSync(paths.data_dir, { recursive: true });
mkdirSync(paths.agents_dir, { recursive: true });
mkdirSync(paths.logs_dir, { recursive: true });

const redisUrl = config.platform.redis?.url;
if (!redisUrl) {
  console.error("ERROR: no redis config in ~/.stockade/config.yaml");
  process.exit(1);
}

const candidates = Object.entries(config.agents.agents)
  .filter(([id, cfg]) => id !== "gatekeeper" && !cfg.sandboxed);

if (!candidates.length) {
  console.error("No non-sandboxed agents configured");
  process.exit(1);
}

const [agentId] = candidates[0];

// ── Infrastructure ─────────────────────────────────────────────────────────

const db = new Database(paths.sessions_db);
initSessionsTable(db);

const workerManager = new HostWorkerManager(paths.agents_dir, paths.logs_dir, { REDIS_URL: redisUrl });
const orchestratorCallbackUrl = `http://localhost:${CALLBACK_PORT}`;

const bus = new EventBus({ redisUrl, sessionIdleTimeoutSec: 300 });
const gate = new ConcurrencyGate(5);

const sessionManager = new SessionManager({
  bus,
  gate,
  allAgents: config.agents,
  platform: config.platform,
  agentsDir: paths.agents_dir,
  platformRoot: paths.data_dir,
  workerManager,
  proxy: undefined,
  orchestratorCallbackUrl,
  schedulerEnabled: false,
  redisUrl,
  getSessionId: (scope) => getSessionId(db, scope),
  setSessionId: (scope, id) => setSessionId(db, scope, id),
});

const bridge = new OrchestratorBridge(bus, sessionManager, 120_000);
await bridge.start();

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
      proxy: undefined,
      orchestratorCallbackUrl,
    };
  },
);

// ── Dispatch ─────────────────────────────────────────────────────────────

const scope = `test:redis-dispatch:${Date.now()}`;
const prompt = "Reply with exactly: REDIS_OK";

console.log(`\n[test] Agent:  ${agentId}`);
console.log(`[test] Scope:  ${scope}`);
console.log(`[test] Prompt: "${prompt}"\n`);
console.log("[test] Dispatching via Redis bus...\n");

const start = Date.now();

try {
  const result = await bridge.sendAndWait(scope, prompt, {
    userId: "test",
    userPlatform: "terminal",
    agentId,
  });

  const elapsed = Date.now() - start;
  console.log(`\n[test] Result received in ${(elapsed / 1000).toFixed(1)}s:\n`);
  console.log(result);

  if (result.startsWith("Error:")) {
    console.log("\n[test] ✗ Error response");
    process.exitCode = 1;
  } else {
    console.log("\n[test] ✓ PASS — agent responded via Redis pub/sub");
  }
} catch (err) {
  console.error("\n[test] ✗ Exception:", err);
  process.exitCode = 1;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

stopCallbackServer();
await bridge.shutdown();
await sessionManager.closeAll();
await workerManager.shutdownAll();
db.close();
process.exit(process.exitCode ?? 0);
