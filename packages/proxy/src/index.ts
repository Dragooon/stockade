import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadProxyConfig } from "./shared/config.js";
import { startHttpProxy } from "./http/proxy.js";
import { startSshTunnel } from "./ssh/tunnel.js";
import { startGateway } from "./gateway/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const configDir = resolve(__dirname, "../../../config");
const config = loadProxyConfig(configDir);

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
