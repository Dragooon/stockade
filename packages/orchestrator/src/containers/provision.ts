import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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
  port: number,
  agentsDir?: string
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
    env.CURL_CA_BUNDLE = "/certs/proxy-ca.crt";
    env.REQUESTS_CA_BUNDLE = "/certs/proxy-ca.crt";
    env.SSL_CERT_FILE = "/certs/proxy-ca.crt";
    env.APW_GATEWAY = `http://${proxyHost}:10256`;
    env.APW_TOKEN = gatewayToken;
    env.PYTHONIOENCODING = "utf-8";

    // Resolve credential env vars for CLI tools (e.g. tavily CLI)
    const credentialEnvMap: Record<string, string> = {
      "tavily-api-key": "TAVILY_API_KEY",
    };
    for (const credKey of agentConfig.credentials ?? []) {
      const envVar = credentialEnvMap[credKey];
      if (envVar && !env[envVar]) {
        try {
          const res = await fetch(
            `http://${proxyHost}:10256/gateway/reveal/${credKey}`,
            {
              headers: { Authorization: `Bearer ${gatewayToken}` },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { value: string };
            env[envVar] = data.value;
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // 3. Build volume mounts
  const volumes: string[] = [];

  // The Agent SDK requires ~/.claude/.credentials.json to initialize.
  // Write a mock credential file that satisfies the SDK's startup check
  // without leaking real tokens. The proxy handles actual API auth.
  const mockCredsPath = resolve(containerDir, "credentials.json");
  writeFileSync(mockCredsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-stub-container-proxy-handles-auth",
      refreshToken: "stub",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      scopes: "user:inference",
      subscriptionType: "pro",
      rateLimitTier: "tier4",
    },
  }));
  volumes.push(`${mockCredsPath}:/home/node/.claude/.credentials.json:ro`);

  if (proxyAvailable) {
    // Proxy CA cert — required for TLS through the MITM proxy
    const caCertPath = resolve(containersConfig.proxy_ca_cert);
    if (existsSync(caCertPath)) {
      volumes.push(`${caCertPath}:/certs/proxy-ca.crt:ro`);
    }
  }

  // Agent workspace — mount the agent's host workspace as /workspace in the container.
  // The SDK uses this as cwd, so CLAUDE.md, skills, and memory are available.
  if (agentsDir) {
    const workspaceDir = resolve(agentsDir, agentId);
    mkdirSync(workspaceDir, { recursive: true });
    volumes.push(`${workspaceDir}:/workspace`);
    env.AGENT_WORKSPACE = "/workspace";
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
