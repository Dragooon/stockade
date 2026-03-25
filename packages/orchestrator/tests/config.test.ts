import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig, substituteEnvVars } from "../src/config.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `config-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeYaml(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf-8");
}

const VALID_AGENTS = `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    lifecycle: persistent
    remote: false
  researcher:
    model: claude-haiku-4-5-20251001
    system: "You research."
    tools: ["WebSearch"]
    lifecycle: persistent
    remote: true
    port: 3001
    url: http://localhost:3001
`;

const VALID_PLATFORM = `
channels:
  terminal:
    enabled: true
    agent: main
  discord:
    enabled: true
    token: test-token-123
    bindings:
      - server: "111"
        agent: main
        channels: "*"
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
        - "tool:*"
    user:
      permissions:
        - "agent:main"
  users:
    alice:
      roles:
        - owner
      identities:
        discord: "999"
        terminal: "alice"
`;

describe("config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid agents and platform config", () => {
    writeYaml(tmpDir, "agents.yaml", VALID_AGENTS);
    writeYaml(tmpDir, "platform.yaml", VALID_PLATFORM);

    const config = loadConfig(tmpDir);

    expect(config.agents.agents.main.model).toBe("claude-sonnet-4-20250514");
    expect(config.agents.agents.main.tools).toEqual(["Bash", "Read"]);
    expect(config.agents.agents.main.remote).toBe(false);
    expect(config.agents.agents.researcher.remote).toBe(true);
    expect(config.agents.agents.researcher.port).toBe(3001);

    expect(config.platform.channels.terminal?.enabled).toBe(true);
    expect(config.platform.channels.discord?.token).toBe("test-token-123");
    expect(config.platform.rbac.users.alice.roles).toEqual(["owner"]);
  });

  it("rejects invalid agents config (missing required field)", () => {
    writeYaml(
      tmpDir,
      "agents.yaml",
      `
agents:
  broken:
    model: sonnet
    # missing system, tools, lifecycle
`
    );
    writeYaml(tmpDir, "platform.yaml", VALID_PLATFORM);

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it("rejects invalid platform config (bad rbac)", () => {
    writeYaml(tmpDir, "agents.yaml", VALID_AGENTS);
    writeYaml(
      tmpDir,
      "platform.yaml",
      `
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: "not-an-object"
  users: {}
`
    );

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it("substitutes environment variables", () => {
    process.env.__TEST_TOKEN = "secret-discord-token";

    writeYaml(tmpDir, "agents.yaml", VALID_AGENTS);
    writeYaml(
      tmpDir,
      "platform.yaml",
      `
channels:
  discord:
    enabled: true
    token: \${__TEST_TOKEN}
    bindings:
      - server: "111"
        agent: main
        channels: "*"
rbac:
  roles:
    owner:
      permissions: ["agent:*"]
  users:
    bob:
      roles: [owner]
      identities:
        discord: "123"
`
    );

    const config = loadConfig(tmpDir);
    expect(config.platform.channels.discord?.token).toBe(
      "secret-discord-token"
    );

    delete process.env.__TEST_TOKEN;
  });

  it("substitutes missing env var as empty string", () => {
    delete process.env.__NONEXISTENT_VAR;

    writeYaml(tmpDir, "agents.yaml", VALID_AGENTS);
    writeYaml(
      tmpDir,
      "platform.yaml",
      `
channels:
  discord:
    enabled: true
    token: \${__NONEXISTENT_VAR}
    bindings: []
rbac:
  roles: {}
  users: {}
`
    );

    // Missing env vars are replaced with "" (lenient substitution)
    const config = loadConfig(tmpDir);
    expect(config.platform.channels.discord?.token).toBe("");
  });

  it("defaults remote to false when not specified", () => {
    writeYaml(
      tmpDir,
      "agents.yaml",
      `
agents:
  simple:
    model: sonnet
    system: "Hello"
    tools: ["Bash"]
    lifecycle: ephemeral
`
    );
    writeYaml(tmpDir, "platform.yaml", VALID_PLATFORM);

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.simple.remote).toBe(false);
  });
});

describe("substituteEnvVars", () => {
  it("replaces env vars in strings", () => {
    process.env.__SUB_TEST = "replaced";
    expect(substituteEnvVars("before ${__SUB_TEST} after")).toBe(
      "before replaced after"
    );
    delete process.env.__SUB_TEST;
  });

  it("handles nested objects", () => {
    process.env.__SUB_NESTED = "deep";
    const result = substituteEnvVars({ a: { b: "${__SUB_NESTED}" } });
    expect(result).toEqual({ a: { b: "deep" } });
    delete process.env.__SUB_NESTED;
  });

  it("handles arrays", () => {
    process.env.__SUB_ARR = "item";
    const result = substituteEnvVars(["${__SUB_ARR}", "plain"]);
    expect(result).toEqual(["item", "plain"]);
    delete process.env.__SUB_ARR;
  });

  it("passes through non-string primitives", () => {
    expect(substituteEnvVars(42)).toBe(42);
    expect(substituteEnvVars(true)).toBe(true);
    expect(substituteEnvVars(null)).toBe(null);
  });
});
