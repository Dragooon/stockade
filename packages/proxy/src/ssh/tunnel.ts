import ssh2 from "ssh2";
const { Server: SshServer, Client: SshClient, utils } = ssh2;
type Connection = ssh2.Connection;
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import type { ProxyConfig, SshRoute } from "../shared/types.js";
import { evaluatePolicy } from "../shared/policy.js";
import { resolveCredential } from "../shared/credentials.js";
import { ensureSSHCA, validateAgentCert, type SshCaBundle } from "./certs.js";

/**
 * Start the SSH tunnel server (jump host / bastion).
 * Agents connect with short-lived certificates.
 * The proxy authenticates to targets using real SSH keys from the credential provider.
 *
 * Accepts a config getter for hot-reloading policy and routes.
 * SSH CA and host key are loaded once at startup.
 */
export function startSshTunnel(getConfig: () => ProxyConfig): InstanceType<typeof SshServer> {
  const initialConfig = getConfig();
  const ca = ensureSSHCA(initialConfig.ssh.ca_key);

  // Generate a host key for our SSH server
  // ssh2 requires traditional PEM (PKCS1), not PKCS8
  const { privateKey: hostKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const server = new SshServer(
    {
      hostKeys: [hostKey],
    },
    (client: Connection) => {
      handleClient(client, getConfig(), ca);
    }
  );

  const host = initialConfig.host ?? "127.0.0.1";
  server.listen(initialConfig.ssh.port, host, () => {
    console.log(`[ssh-tunnel] listening on ${host}:${initialConfig.ssh.port}`);
  });

  return server;
}

function handleClient(
  client: Connection,
  config: ProxyConfig,
  ca: SshCaBundle
): void {
  let authenticatedAgentId: string | null = null;

  client.on("authentication", (ctx) => {
    if (ctx.method === "password") {
      // Password field carries the base64-encoded agent certificate
      const certResult = validateAgentCert(ca, ctx.password);
      if (certResult) {
        authenticatedAgentId = certResult.agentId;
        ctx.accept();
        return;
      }
    }
    ctx.reject(["password"]);
  });

  client.on("ready", () => {
    console.log(`[ssh-tunnel] agent "${authenticatedAgentId}" connected`);

    client.on("tcpip", (accept, reject, info) => {
      handleTunnel(accept, reject, info, config, ca, authenticatedAgentId);
    });

    // Handle direct-tcpip (port forwarding / ProxyJump)
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", async (acceptExec, rejectExec, info) => {
        // Exec requests could carry the target host info
        // For ProxyJump, SSH sends a "direct-tcpip" channel instead
        rejectExec?.();
      });
    });

    (client as any).on("openssh.directstreamlocal", (accept: () => any, reject: (() => void) | undefined, info: any) => {
      reject?.();
    });
  });

  client.on("error", (err) => {
    console.error("[ssh-tunnel] client error:", err.message);
  });
}

async function handleTunnel(
  accept: () => any,
  reject: () => void,
  info: { destIP: string; destPort: number },
  config: ProxyConfig,
  _ca: SshCaBundle,
  _agentId: string | null
): Promise<void> {
  const targetHost = info.destIP;
  const targetPort = info.destPort || 22;

  // Policy check
  const action = evaluatePolicy(config.policy, {
    host: targetHost,
    port: targetPort,
  });

  if (action === "deny") {
    console.log(`[ssh-tunnel] denied: ${targetHost}:${targetPort}`);
    reject();
    return;
  }

  // Find matching route for credential lookup
  const route = config.ssh.routes.find(
    (r) => r.host === targetHost && (r.port ?? 22) === targetPort
  );

  if (!route) {
    console.log(`[ssh-tunnel] no route for ${targetHost}:${targetPort}`);
    reject();
    return;
  }

  try {
    // Resolve the target's SSH private key from the credential provider
    const privateKey = await resolveCredential(
      config.provider,
      route.credential
    );

    // Connect to the target
    const targetClient = new SshClient();
    const channel = accept();

    targetClient.on("ready", () => {
      targetClient.forwardOut(
        "127.0.0.1",
        0,
        targetHost,
        targetPort,
        (err, upstream) => {
          if (err) {
            console.error("[ssh-tunnel] forward error:", err.message);
            channel.close();
            targetClient.end();
            return;
          }
          // Bridge the streams
          channel.pipe(upstream).pipe(channel);
        }
      );
    });

    targetClient.on("error", (err) => {
      console.error("[ssh-tunnel] target connection error:", err.message);
      channel.close();
    });

    targetClient.connect({
      host: targetHost,
      port: targetPort,
      username: route.user,
      privateKey,
    });

    channel.on("close", () => {
      targetClient.end();
    });
  } catch (err) {
    console.error("[ssh-tunnel] credential resolution error:", err);
    reject();
  }
}
