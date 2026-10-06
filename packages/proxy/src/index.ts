import { join } from "node:path";
import { homedir } from "node:os";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { config as loadEnv } from "dotenv";
import { loadProxyConfig } from "./shared/config.js";
import { watchProxyConfig } from "./shared/watch.js";
import { invalidateCache } from "./shared/credentials.js";
import { initTokenStore } from "./gateway/tokens.js";
import { startHttpProxy } from "./http/proxy.js";
import { startSshTunnel } from "./ssh/tunnel.js";
import { startGateway } from "./gateway/api.js";

// Load .env from platform home (~/.stockade/.env)
const PLATFORM_HOME = join(homedir(), ".stockade");
loadEnv({ path: join(PLATFORM_HOME, ".env") });
let config = loadProxyConfig(PLATFORM_HOME);
const getConfig = () => config;
initTokenStore(join(PLATFORM_HOME, "proxy", "gateway-tokens.json"));

// Node's happy-eyeballs gives each upstream address only 250ms to complete a
// TCP handshake before moving on. From here, hosts with ~300ms RTT (e.g.
// api.tailscale.com at 308ms) time out on EVERY address and the MITM returns
// 502 "fetch failed / ETIMEDOUT" even though curl reaches them fine.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

console.log("[proxy] starting all servers...");

// Start HTTP proxy
const httpServer = startHttpProxy(getConfig);

// Start SSH tunnel
const sshServer = startSshTunnel(getConfig);

// Start gateway API
const gatewayServer = startGateway(getConfig);

// Hot reload config on file changes
const stopWatch = watchProxyConfig(PLATFORM_HOME, (next) => {
  config = next;
  // An edited override changes where a key reads from; don't serve the old value.
  invalidateCache();
});

// Graceful shutdown
function shutdown() {
  console.log("[proxy] shutting down...");
  stopWatch();
  httpServer.close();
  sshServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
