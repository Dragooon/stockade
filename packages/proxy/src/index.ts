import { join } from "node:path";
import { homedir } from "node:os";
import { config as loadEnv } from "dotenv";
import { loadProxyConfig } from "./shared/config.js";
import { watchProxyConfig } from "./shared/watch.js";
import { startHttpProxy } from "./http/proxy.js";
import { startSshTunnel } from "./ssh/tunnel.js";
import { startGateway } from "./gateway/api.js";

// Load .env from platform home (~/.stockade/.env)
const PLATFORM_HOME = join(homedir(), ".stockade");
loadEnv({ path: join(PLATFORM_HOME, ".env") });
let config = loadProxyConfig(PLATFORM_HOME);
const getConfig = () => config;

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
