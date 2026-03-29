import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";

export interface SshCaBundle {
  publicKey: string;
  privateKey: string;
}

export interface AgentCert {
  /** The certificate data (to be written to a file for the agent) */
  certificate: string;
  /** The agent's ephemeral public key */
  publicKey: string;
  /** The agent's ephemeral private key (agent needs this to connect) */
  privateKey: string;
  /** Principal (agent ID) encoded in the cert */
  principal: string;
  /** Expiry timestamp (ms) */
  expiresAt: number;
}

/**
 * Load or generate the SSH CA key pair.
 * The CA signs agent certificates for proxy authentication.
 */
export function ensureSSHCA(caKeyPath: string): SshCaBundle {
  const pubPath = caKeyPath + ".pub";

  if (existsSync(caKeyPath) && existsSync(pubPath)) {
    return {
      privateKey: readFileSync(caKeyPath, "utf-8"),
      publicKey: readFileSync(pubPath, "utf-8"),
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  mkdirSync(dirname(caKeyPath), { recursive: true });
  writeFileSync(caKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey);

  return { publicKey, privateKey };
}

/**
 * Issue a short-lived certificate for an agent.
 * The cert encodes the agent ID as principal and has a limited TTL.
 *
 * This is a simplified cert format — in production you'd use proper
 * OpenSSH certificate format. Here we use a signed JSON payload
 * that the SSH tunnel server can verify.
 */
export function issueAgentCert(
  ca: SshCaBundle,
  agentId: string,
  ttlSeconds: number
): AgentCert {
  // Generate ephemeral key pair for the agent
  const agentKeys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const expiresAt = Date.now() + ttlSeconds * 1000;

  // Create certificate payload
  const payload = JSON.stringify({
    principal: agentId,
    publicKey: agentKeys.publicKey,
    issuedAt: Date.now(),
    expiresAt,
    nonce: randomBytes(16).toString("hex"),
  });

  // Sign with CA private key (Ed25519 uses sign() directly, not createSign)
  const payloadBuf = Buffer.from(payload);
  const caKey = createPrivateKey(ca.privateKey);
  const signature = sign(null, payloadBuf, caKey).toString("base64");

  const certificate = Buffer.from(
    JSON.stringify({ payload, signature })
  ).toString("base64");

  return {
    certificate,
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
    principal: agentId,
    expiresAt,
  };
}

/**
 * Validate an agent certificate against the CA public key.
 * Returns the agent ID (principal) if valid, null if invalid or expired.
 */
export function validateAgentCert(
  ca: SshCaBundle,
  certificate: string
): { agentId: string } | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(certificate, "base64").toString("utf-8")
    );

    const { payload, signature } = decoded;

    // Verify signature (Ed25519 uses verify() directly)
    const payloadBuf = Buffer.from(payload);
    const sigBuf = Buffer.from(signature, "base64");
    const pubKey = createPublicKey(ca.publicKey);
    if (!verify(null, payloadBuf, pubKey, sigBuf)) {
      return null;
    }

    const data = JSON.parse(payload);

    // Check expiry
    if (data.expiresAt <= Date.now()) {
      return null;
    }

    return { agentId: data.principal };
  } catch {
    return null;
  }
}
