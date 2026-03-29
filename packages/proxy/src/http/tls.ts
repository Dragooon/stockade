import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import forge from "node-forge";

const certCache = new Map<string, { cert: string; key: string }>();

export interface CaBundle {
  cert: forge.pki.Certificate;
  key: forge.pki.PrivateKey;
  certPem: string;
  keyPem: string;
}

/**
 * Load or generate the proxy CA certificate + key.
 * If files exist, loads them. Otherwise generates a self-signed CA
 * and writes to disk.
 */
export function ensureCA(certPath: string, keyPath: string): CaBundle {
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, "utf-8");
    const keyPem = readFileSync(keyPath, "utf-8");
    return {
      cert: forge.pki.certificateFromPem(certPem),
      key: forge.pki.privateKeyFromPem(keyPem),
      certPem,
      keyPem,
    };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notAfter.getFullYear() + 10
  );

  const attrs = [
    { name: "commonName", value: "Agent Platform Proxy CA" },
    { name: "organizationName", value: "Agent Platform" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Ensure parent dirs exist
  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);

  return { cert, key: keys.privateKey, certPem, keyPem };
}

/**
 * Generate a TLS certificate for a hostname, signed by the proxy CA.
 * Results are cached by hostname.
 */
export function generateCert(
  hostname: string,
  ca: CaBundle
): { cert: string; key: string } {
  const cached = certCache.get(hostname);
  if (cached) return cached;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notAfter.getFullYear() + 1
  );

  cert.setSubject([{ name: "commonName", value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);

  cert.setExtensions([
    {
      name: "subjectAltName",
      altNames: [{ type: 2, value: hostname }], // DNS
    },
  ]);

  cert.sign(ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  const result = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };

  certCache.set(hostname, result);
  return result;
}

/** Clear the hostname cert cache */
export function clearCertCache(): void {
  certCache.clear();
}
