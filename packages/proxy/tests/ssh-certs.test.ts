import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  ensureSSHCA,
  issueAgentCert,
  validateAgentCert,
} from "../src/ssh/certs.js";

const tmpBase = resolve(tmpdir(), `proxy-ssh-test-${randomBytes(4).toString("hex")}`);
const caKeyPath = resolve(tmpBase, "ssh_ca");

describe("SSH certificate authority", () => {
  afterEach(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true });
    }
  });

  it("generates SSH CA key pair", () => {
    const ca = ensureSSHCA(caKeyPath);
    expect(ca.privateKey).toContain("PRIVATE KEY");
    expect(ca.publicKey).toContain("PUBLIC KEY");
    expect(existsSync(caKeyPath)).toBe(true);
    expect(existsSync(caKeyPath + ".pub")).toBe(true);
  });

  it("loads existing CA from disk", () => {
    const ca1 = ensureSSHCA(caKeyPath);
    const ca2 = ensureSSHCA(caKeyPath);
    expect(ca2.privateKey).toBe(ca1.privateKey);
  });

  it("issues an agent certificate", () => {
    const ca = ensureSSHCA(caKeyPath);
    const cert = issueAgentCert(ca, "main", 3600);
    expect(cert.principal).toBe("main");
    expect(cert.certificate).toBeTruthy();
    expect(cert.publicKey).toContain("PUBLIC KEY");
    expect(cert.privateKey).toContain("PRIVATE KEY");
    expect(cert.expiresAt).toBeGreaterThan(Date.now());
  });

  it("validates a valid agent certificate", () => {
    const ca = ensureSSHCA(caKeyPath);
    const cert = issueAgentCert(ca, "researcher", 3600);
    const result = validateAgentCert(ca, cert.certificate);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("researcher");
  });

  it("rejects an expired certificate", () => {
    const ca = ensureSSHCA(caKeyPath);
    // Issue with 0 TTL — immediately expired
    const cert = issueAgentCert(ca, "main", 0);

    // Small delay to ensure expiry
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    const result = validateAgentCert(ca, cert.certificate);
    vi.useRealTimers();

    expect(result).toBeNull();
  });

  it("rejects a certificate signed by a different CA", () => {
    const ca1 = ensureSSHCA(caKeyPath);
    const cert = issueAgentCert(ca1, "main", 3600);

    // Create a different CA
    const tmpBase2 = resolve(tmpdir(), `proxy-ssh-test2-${randomBytes(4).toString("hex")}`);
    const ca2 = ensureSSHCA(resolve(tmpBase2, "ssh_ca"));

    const result = validateAgentCert(ca2, cert.certificate);
    expect(result).toBeNull();

    // Cleanup
    if (existsSync(tmpBase2)) {
      rmSync(tmpBase2, { recursive: true });
    }
  });

  it("rejects garbage input", () => {
    const ca = ensureSSHCA(caKeyPath);
    expect(validateAgentCert(ca, "not-a-cert")).toBeNull();
    expect(validateAgentCert(ca, "")).toBeNull();
  });
});
