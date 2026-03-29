import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { ContainersConfig } from "./types.js";
import type { AgentConfig } from "../types.js";

export interface ProvisionResult {
  env: Record<string, string>;
  volumes: string[];
  gatewayToken: string;
  cleanup: () => Promise<void>;
}

/**
 * Provision everything a container needs before starting:
 * - Gateway token (via HTTP call to proxy, if proxy is running)
 * - SSH certificate (if agent has SSH credentials)
 * - Temp files for certs + SSH config
 * - Environment variable map
 * - Volume mount list
 *
 * If the proxy gateway is unreachable, provisioning continues with
 * minimal env (PORT + WORKER_ID only) — the container will work
 * but without credential injection.
 */
export async function provisionContainer(
  agentId: string,
  agentConfig: AgentConfig,
  containersConfig: ContainersConfig,
  proxyGatewayUrl: string,
  dataDir: string,
  port: number
): Promise<ProvisionResult> {
  const containerDir = resolve(dataDir, "containers", agentId);
  mkdirSync(containerDir, { recursive: true });

  // 1. Try to issue gateway token via proxy API (non-fatal if proxy is down)
  let gatewayToken = "";
  let proxyAvailable = false;

  try {
    const tokenRes = await fetch(`${proxyGatewayUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        agentId,
        credentials: agentConfig.credentials ?? [],
        storeKeys: agentConfig.store_keys,
      }),
    });

    if (tokenRes.ok) {
      const data = (await tokenRes.json()) as { token: string; expiresAt: number };
      gatewayToken = data.token;
      proxyAvailable = true;
    }
  } catch {
    // Proxy not running — continue without credential injection
  }

  // 2. Build environment variables
  const env: Record<string, string> = {
    PORT: String(port),
    WORKER_ID: agentId,
  };

  // Pass through ANTHROPIC_API_KEY when proxy isn't handling credential injection
  if (!proxyAvailable && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  if (proxyAvailable) {
    const proxyHost = containersConfig.proxy_host;
    env.HTTP_PROXY = `http://${proxyHost}:10255`;
    env.HTTPS_PROXY = `http://${proxyHost}:10255`;
    env.NO_PROXY = "localhost,127.0.0.1";
    env.NODE_EXTRA_CA_CERTS = "/certs/proxy-ca.crt";
    env.APW_GATEWAY = `http://${proxyHost}:10256`;
    env.APW_TOKEN = gatewayToken;
  }

  // 3. Build volume mounts
  const volumes: string[] = [];

  // The Agent SDK requires Claude Code authentication credentials.
  // Copy the host's OAuth credentials into the container so the SDK can
  // initialize. The proxy still handles credential injection for outbound
  // API calls — these credentials just satisfy the SDK's auth check.
  const hostCredsPath = resolve(homedir(), ".claude", ".credentials.json");
  if (existsSync(hostCredsPath)) {
    const credsContent = readFileSync(hostCredsPath, "utf-8");
    const containerCredsPath = resolve(containerDir, "credentials.json");
    writeFileSync(containerCredsPath, credsContent);
    volumes.push(`${containerCredsPath}:/home/node/.claude/.credentials.json:ro`);
  }

  if (proxyAvailable) {
    // Proxy CA cert
    const caCertPath = resolve(containersConfig.proxy_ca_cert);
    if (existsSync(caCertPath)) {
      volumes.push(`${caCertPath}:/certs/proxy-ca.crt:ro`);
    }

    // apw CLI script
    const apwPath = resolve(containersConfig.apw_path);
    if (existsSync(apwPath)) {
      volumes.push(`${apwPath}:/usr/local/bin/apw:ro`);
    }
  }

  // gogcli (Google services CLI) — mount credentials + token if available.
  // The host exports tokens via `gog auth tokens export` to data/gogcli/.
  // Container uses file-based keyring backend (no Credential Manager).
  const gogcliDataDir = resolve(dataDir, "gogcli");
  if (existsSync(gogcliDataDir)) {
    const gogCredsPath = resolve(gogcliDataDir, "credentials.json");
    const gogTokenPath = resolve(gogcliDataDir, "token-export.json");
    if (existsSync(gogCredsPath)) {
      volumes.push(`${gogCredsPath}:/home/node/.config/gogcli/credentials.json:ro`);
    }
    if (existsSync(gogTokenPath)) {
      // Import the token into the container's file-based keyring at startup.
      // We mount the export file; the container entrypoint imports it.
      volumes.push(`${gogTokenPath}:/home/node/.config/gogcli/token-import.json:ro`);
    }
    env.GOG_ACCOUNT = "botmadge@gmail.com";
    env.GOG_KEYRING_PASSWORD = "stockade";
  }

  // Agent-specific volumes from config
  if (agentConfig.container?.volumes) {
    volumes.push(...agentConfig.container.volumes);
  }

  // 4. Build cleanup function
  const cleanup = async () => {
    // Revoke gateway token (if we got one)
    if (gatewayToken) {
      try {
        await fetch(`${proxyGatewayUrl}/token/${gatewayToken}`, {
          method: "DELETE",
        });
      } catch {
        // Best-effort revocation
      }
    }

    // Remove temp files
    if (existsSync(containerDir)) {
      rmSync(containerDir, { recursive: true, force: true });
    }
  };

  return { env, volumes, gatewayToken, cleanup };
}
