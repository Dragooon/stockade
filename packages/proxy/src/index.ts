import { join } from "node:path";
import { homedir } from "node:os";
import { loadProxyConfig } from "./shared/config.js";
import { startHttpProxy } from "./http/proxy.js";
import { startSshTunnel } from "./ssh/tunnel.js";
import { startGateway } from "./gateway/api.js";

// Load config from platform home (~/.stockade/)
const PLATFORM_HOME = join(homedir(), ".stockade");
const config = loadProxyConfig(PLATFORM_HOME);

console.log("[proxy] starting all servers...");

// Start HTTP proxy
const httpServer = startHttpProxy(config);

// Start SSH tunnel
const sshServer = startSshTunnel(config);

// Start gateway API
const gatewayServer = startGateway(config);

// Graceful shutdown
function shutdown() {
  console.log("[proxy] shutting down...");
  httpServer.close();
  sshServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
