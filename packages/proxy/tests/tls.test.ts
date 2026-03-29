import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ensureCA, generateCert, clearCertCache } from "../src/http/tls.js";

const tmpBase = resolve(tmpdir(), `proxy-tls-test-${randomBytes(4).toString("hex")}`);
const certPath = resolve(tmpBase, "ca.crt");
const keyPath = resolve(tmpBase, "ca.key");

describe("TLS / CA management", () => {
  afterEach(() => {
    clearCertCache();
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true });
    }
  });

  it("generates CA cert + key when files don't exist", () => {
    const ca = ensureCA(certPath, keyPath);
    expect(ca.certPem).toContain("BEGIN CERTIFICATE");
    expect(ca.keyPem).toContain("BEGIN RSA PRIVATE KEY");
    expect(existsSync(certPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("loads existing CA from disk", () => {
    const ca1 = ensureCA(certPath, keyPath);
    const ca2 = ensureCA(certPath, keyPath);
    expect(ca2.certPem).toBe(ca1.certPem);
    expect(ca2.keyPem).toBe(ca1.keyPem);
  });

  it("generates a hostname certificate signed by CA", () => {
    const ca = ensureCA(certPath, keyPath);
    const hostCert = generateCert("api.github.com", ca);
    expect(hostCert.cert).toContain("BEGIN CERTIFICATE");
    expect(hostCert.key).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("caches hostname certificates", () => {
    const ca = ensureCA(certPath, keyPath);
    const cert1 = generateCert("example.com", ca);
    const cert2 = generateCert("example.com", ca);
    expect(cert1).toBe(cert2); // Same reference — cached
  });

  it("generates different certs for different hostnames", () => {
    const ca = ensureCA(certPath, keyPath);
    const cert1 = generateCert("host1.com", ca);
    const cert2 = generateCert("host2.com", ca);
    expect(cert1.cert).not.toBe(cert2.cert);
  });
});
