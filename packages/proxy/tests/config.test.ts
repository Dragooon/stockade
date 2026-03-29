import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ProxyConfigFileSchema } from "../src/shared/types.js";
import { loadProxyConfig } from "../src/shared/config.js";

const validConfig = {
  proxy: {
    host: "127.0.0.1",
    provider: {
      read: "op read op://{key}",
      write: "op item create --vault AgentVault --title {key} --category password password={value}",
      update: "op item edit {key} --vault AgentVault password={value}",
      cache_ttl: 300,
    },
    policy: {
      default: "deny" as const,
      rules: [
        { host: "api.anthropic.com", action: "allow" as const },
        { host: "*", action: "deny" as const },
      ],
    },
    http: {
      port: 10255,
      tls: {
        ca_cert: "./data/proxy/ca.crt",
        ca_key: "./data/proxy/ca.key",
      },
      strip_headers: ["authorization", "x-api-key"],
      routes: [
        {
          host: "api.anthropic.com",
          credential: "AgentVault/Anthropic/api-key",
          inject: { header: "x-api-key" },
        },
      ],
    },
    ssh: {
      port: 10022,
      ca_key: "./data/proxy/ssh_ca",
      routes: [
        {
          host: "github.com",
          credential: "AgentVault/SSH/github-deploy-key",
          user: "git",
        },
      ],
    },
    gateway: {
      port: 10256,
      token_ttl: 86400,
    },
  },
};

describe("ProxyConfigFileSchema", () => {
  it("parses a valid config", () => {
    const result = ProxyConfigFileSchema.parse(validConfig);
    expect(result.proxy.http.port).toBe(10255);
    expect(result.proxy.policy.default).toBe("deny");
    expect(result.proxy.ssh.routes[0].user).toBe("git");
  });

  it("applies defaults for omitted fields", () => {
    const minimal = {
      proxy: {
        provider: validConfig.proxy.provider,
        policy: validConfig.proxy.policy,
        http: {
          tls: validConfig.proxy.http.tls,
          routes: [],
        },
        ssh: {
          ca_key: "./data/proxy/ssh_ca",
          routes: [],
        },
        gateway: {},
      },
    };
    const result = ProxyConfigFileSchema.parse(minimal);
    expect(result.proxy.host).toBe("127.0.0.1");
    expect(result.proxy.http.port).toBe(10255);
    expect(result.proxy.http.strip_headers).toEqual([
      "authorization",
      "x-api-key",
      "proxy-authorization",
    ]);
    expect(result.proxy.ssh.port).toBe(10022);
    expect(result.proxy.gateway.port).toBe(10256);
    expect(result.proxy.gateway.token_ttl).toBe(86400);
  });

  it("rejects invalid credential key format", () => {
    const bad = structuredClone(validConfig);
    bad.proxy.http.routes[0].credential = "bad key with spaces";
    expect(() => ProxyConfigFileSchema.parse(bad)).toThrow();
  });

  it("rejects invalid policy action", () => {
    const bad = structuredClone(validConfig);
    (bad.proxy.policy.rules[0] as any).action = "maybe";
    expect(() => ProxyConfigFileSchema.parse(bad)).toThrow();
  });

  it("rejects missing provider config", () => {
    const bad = structuredClone(validConfig);
    delete (bad.proxy as any).provider;
    expect(() => ProxyConfigFileSchema.parse(bad)).toThrow();
  });

  it("rejects negative cache_ttl", () => {
    const bad = structuredClone(validConfig);
    bad.proxy.provider.cache_ttl = -1;
    expect(() => ProxyConfigFileSchema.parse(bad)).toThrow();
  });
});

// ── loadProxyConfig — loads and validates YAML from disk ──────────────────

const validYaml = `
proxy:
  host: "127.0.0.1"
  provider:
    read: "op read op://{key}"
    write: "op item create --title {key} password={value}"
    update: "op item edit {key} password={value}"
    cache_ttl: 300
  policy:
    default: deny
    rules:
      - host: api.anthropic.com
        action: allow
      - host: "*.github.com"
        action: allow
  http:
    port: 10255
    tls:
      ca_cert: "./ca.crt"
      ca_key: "./ca.key"
    strip_headers:
      - authorization
    routes:
      - host: api.anthropic.com
        credential: AgentVault/Anthropic/api-key
        inject:
          header: x-api-key
  ssh:
    port: 10022
    ca_key: "./ssh_ca"
    routes:
      - host: github.com
        credential: AgentVault/SSH/deploy-key
        user: git
  gateway:
    port: 10256
    token_ttl: 86400
`;

describe("loadProxyConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `proxy-config-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("loads and parses a valid proxy.yaml from disk", () => {
    writeFileSync(resolve(tmpDir, "proxy.yaml"), validYaml, "utf-8");
    const config = loadProxyConfig(tmpDir);

    expect(config.host).toBe("127.0.0.1");
    expect(config.http.port).toBe(10255);
    expect(config.policy.default).toBe("deny");
    expect(config.policy.rules).toHaveLength(2);
    expect(config.policy.rules[0].host).toBe("api.anthropic.com");
    expect(config.policy.rules[0].action).toBe("allow");
    expect(config.http.routes[0].credential).toBe("AgentVault/Anthropic/api-key");
    expect(config.http.routes[0].inject.header).toBe("x-api-key");
    expect(config.ssh.routes[0].host).toBe("github.com");
    expect(config.ssh.routes[0].user).toBe("git");
    expect(config.gateway.port).toBe(10256);
    expect(config.gateway.token_ttl).toBe(86400);
    expect(config.provider.cache_ttl).toBe(300);
  });

  it("applies Zod defaults for omitted optional fields", () => {
    const minimalYaml = `
proxy:
  provider:
    read: "op read op://{key}"
    write: "op item create --title {key} password={value}"
    update: "op item edit {key} password={value}"
  policy:
    default: allow
    rules: []
  http:
    tls:
      ca_cert: "./ca.crt"
      ca_key: "./ca.key"
    routes: []
  ssh:
    ca_key: "./ssh_ca"
    routes: []
  gateway: {}
`;
    writeFileSync(resolve(tmpDir, "proxy.yaml"), minimalYaml, "utf-8");
    const config = loadProxyConfig(tmpDir);

    expect(config.host).toBe("127.0.0.1");
    expect(config.http.port).toBe(10255);
    expect(config.http.strip_headers).toEqual(["authorization", "x-api-key", "proxy-authorization"]);
    expect(config.ssh.port).toBe(10022);
    expect(config.gateway.port).toBe(10256);
    expect(config.gateway.token_ttl).toBe(86400);
    expect(config.provider.cache_ttl).toBe(300);
  });

  it("throws when proxy.yaml does not exist", () => {
    expect(() => loadProxyConfig(tmpDir)).toThrow();
  });

  it("throws when proxy.yaml contains malformed YAML", () => {
    writeFileSync(resolve(tmpDir, "proxy.yaml"), "{{{{not: yaml: at: all", "utf-8");
    expect(() => loadProxyConfig(tmpDir)).toThrow();
  });

  it("throws when YAML is valid but schema validation fails", () => {
    const invalidYaml = `
proxy:
  policy:
    default: deny
    rules: []
`;
    writeFileSync(resolve(tmpDir, "proxy.yaml"), invalidYaml, "utf-8");
    expect(() => loadProxyConfig(tmpDir)).toThrow();
  });
});
