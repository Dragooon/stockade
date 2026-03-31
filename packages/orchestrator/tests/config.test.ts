import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { loadConfig, substituteEnvVars, resolvePaths, PLATFORM_HOME } from "../src/config.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `config-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeYaml(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf-8");
}

const VALID_CONFIG = `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    sandboxed: false
  researcher:
    model: claude-haiku-4-5-20251001
    system: "You research."
    tools: ["WebSearch"]
    sandboxed: true
    port: 3001
    url: http://localhost:3001
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
    writeYaml(tmpDir, "config.yaml", VALID_CONFIG);

    const config = loadConfig(tmpDir);

    expect(config.agents.agents.main.model).toBe("claude-sonnet-4-20250514");
    expect(config.agents.agents.main.tools).toEqual(["Bash", "Read"]);
    expect(config.agents.agents.main.sandboxed).toBe(false);
    expect(config.agents.agents.researcher.sandboxed).toBe(true);
    expect(config.agents.agents.researcher.port).toBe(3001);

    expect(config.platform.channels.terminal?.enabled).toBe(true);
    expect(config.platform.channels.discord?.token).toBe("test-token-123");
    expect(config.platform.rbac.users.alice.roles).toEqual(["owner"]);
  });

  it("rejects invalid agents config (missing required field)", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  broken:
    # missing model (required)
    system: "hello"
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
  users: {}
`
    );

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it("rejects invalid platform config (bad rbac)", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    sandboxed: false
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

    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    sandboxed: false
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

    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools: ["Bash", "Read"]
    sandboxed: false
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

  it("resolves paths with defaults to ~/.stockade when paths section omitted", () => {
    writeYaml(tmpDir, "config.yaml", VALID_CONFIG);

    const config = loadConfig(tmpDir);
    const paths = config.platform.paths!;

    expect(paths).toBeDefined();
    expect(paths.config_dir).toBe(join(tmpDir)); // normalized
    // Default data_dir is ~/.stockade (decoupled from project)
    expect(paths.data_dir).toBe(PLATFORM_HOME);
    expect(paths.agents_dir).toBe(join(PLATFORM_HOME, "agents"));
    expect(paths.sessions_db).toBe(join(PLATFORM_HOME, "sessions.db"));
    expect(paths.containers_dir).toBe(join(PLATFORM_HOME, "containers"));
  });

  it("PLATFORM_HOME points to ~/.stockade", () => {
    expect(PLATFORM_HOME).toBe(join(homedir(), ".stockade"));
  });

  it("resolves custom paths relative to project root", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      VALID_CONFIG +
        `paths:\n  data_dir: ./my-data\n  agents_dir: ./my-data/my-agents\n`
    );

    const projectRoot = join(tmpDir, "..");
    const config = loadConfig(tmpDir, projectRoot);
    const paths = config.platform.paths!;

    expect(paths.data_dir).toBe(join(projectRoot, "my-data"));
    expect(paths.agents_dir).toBe(join(projectRoot, "my-data", "my-agents"));
    // sessions_db falls back to <data_dir>/sessions.db
    expect(paths.sessions_db).toBe(join(projectRoot, "my-data", "sessions.db"));
  });

  it("resolves absolute paths as-is", () => {
    const absPath = join(tmpDir, "absolute-data");
    writeYaml(
      tmpDir,
      "config.yaml",
      VALID_CONFIG + `paths:\n  data_dir: ${absPath}\n`
    );

    const config = loadConfig(tmpDir);
    const paths = config.platform.paths!;

    expect(paths.data_dir).toBe(absPath);
    expect(paths.agents_dir).toBe(join(absPath, "agents"));
  });

  it("defaults sandboxed to false when not specified", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  simple:
    model: sonnet
    system: "Hello"
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.simple.sandboxed).toBe(false);
  });

  it("defaults system_mode to replace when not specified", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.system_mode).toBe("replace");
  });

  it("accepts system_mode: append", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    system_mode: append
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.system_mode).toBe("append");
  });

  it("defaults effort to undefined when not specified", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.effort).toBeUndefined();
  });

  it("accepts effort: high", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    effort: high
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.effort).toBe("high");
  });

  it("rejects invalid effort value", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    effort: turbo
    tools: ["Bash"]
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it("defaults memory to enabled with no autoDream when not specified", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    // Zod fills in the default: memory is always present with sensible defaults
    expect(config.agents.agents.main.memory).toEqual({
      enabled: true,
      autoDream: false,
    });
  });

  it("parses memory config with defaults", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    memory:
      enabled: true
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.memory).toEqual({
      enabled: true,
      autoDream: false,
    });
  });

  it("parses memory config with autoDream", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: sonnet
    system: "Hello"
    memory:
      enabled: true
      autoDream: true
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles: {}
  users: {}
`
    );

    const config = loadConfig(tmpDir);
    expect(config.agents.agents.main.memory).toEqual({
      enabled: true,
      autoDream: true,
    });
  });

  it("throws when config.yaml is missing", () => {
    // tmpDir exists but contains no config.yaml
    expect(() => loadConfig(tmpDir)).toThrow();
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
