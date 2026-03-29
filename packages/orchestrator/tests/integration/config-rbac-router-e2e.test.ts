/**
 * E2E tests for Config Loading, RBAC, and Router — as a real user would encounter them.
 *
 * These tests exercise the full public surface of loadConfig / substituteEnvVars,
 * checkAccess / buildPermissionHook, and resolveAgent using real YAML files on disk
 * (temp dirs) and the actual test-terminal config directory (config.yaml).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { loadConfig, substituteEnvVars } from "../../src/config.js";
import { checkAccess, buildPermissionHook } from "../../src/rbac.js";
import { resolveAgent } from "../../src/router.js";
import type { PlatformConfig } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "e2e-config-"));
}

function writeYaml(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf-8");
}

/** Absolute path to the test-terminal fixture config. */
const TEST_TERMINAL_CONFIG_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../fixtures/test-terminal"
);

// ---------------------------------------------------------------------------
// Shared YAML fixtures used across multiple tests
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are a helpful assistant."
    tools:
      - Bash
      - Read
    sandboxed: false
  researcher:
    model: claude-haiku-4-5-20251001
    system: "You research topics."
    tools:
      - WebSearch
    sandboxed: true
    port: 3001
    url: "http://localhost:3001"
channels:
  terminal:
    enabled: true
    agent: main
  discord:
    enabled: true
    token: "test-discord-token"
    bindings:
      - server: "server-111"
        agent: main
        channels: "*"
      - server: "server-222"
        agent: researcher
        channels:
          - "ch-alpha"
          - "ch-beta"
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
        - "tool:*"
    user:
      permissions:
        - "agent:main"
        - "tool:Read"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "alice"
        discord: "discord-alice-999"
    bob:
      roles:
        - user
      identities:
        terminal: "bob"
        discord: "discord-bob-456"
`;

// ---------------------------------------------------------------------------
// ── CONFIG — positive ──
// ---------------------------------------------------------------------------

describe("Config — positive", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 1 — Load real test-terminal config from disk
  it("loads real test-terminal config — agents and platform parse correctly", () => {
    const { agents, platform } = loadConfig(TEST_TERMINAL_CONFIG_DIR);

    // config.yaml declares a 'main' agent
    expect(agents.agents).toHaveProperty("main");
    const main = agents.agents.main;
    expect(typeof main.model).toBe("string");
    expect(main.model.length).toBeGreaterThan(0);
    expect(Array.isArray(main.tools)).toBe(true);
    expect(main.tools.length).toBeGreaterThan(0);
    expect(typeof main.system).toBe("string");

    // config.yaml has terminal channel pointing to main
    expect(platform.channels.terminal).toBeDefined();
    expect(platform.channels.terminal!.enabled).toBe(true);
    expect(platform.channels.terminal!.agent).toBe("main");

    // RBAC is present
    expect(platform.rbac.roles).toBeDefined();
    expect(platform.rbac.users).toBeDefined();
  });

  // Test 2 — containers block with max_concurrent and network parses and applies defaults
  it("parses config with containers block and applies schema defaults", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
${MINIMAL_CONFIG}
containers:
  max_concurrent: 10
  network: "my-custom-net"
`
    );

    const { platform } = loadConfig(tmpDir);

    expect(platform.containers).toBeDefined();
    expect(platform.containers!.max_concurrent).toBe(10);
    expect(platform.containers!.network).toBe("my-custom-net");
    // Defaults should be filled in by Zod
    expect(platform.containers!.proxy_host).toBe("host.docker.internal");
    expect(platform.containers!.session_idle_minutes).toBe(30);
    expect(platform.containers!.defaults.memory).toBe("1g");
    expect(platform.containers!.defaults.cpus).toBe(1.0);
  });

  // Test 3 — scheduler block parses poll_interval_ms and timezone
  it("parses config with scheduler block correctly", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
${MINIMAL_CONFIG}
scheduler:
  poll_interval_ms: 5000
  timezone: "America/New_York"
`
    );

    const { platform } = loadConfig(tmpDir);

    expect(platform.scheduler).toBeDefined();
    expect(platform.scheduler!.poll_interval_ms).toBe(5000);
    expect(platform.scheduler!.timezone).toBe("America/New_York");
  });

  // Test 4 — Env var substitution: ${MY_VAR} replaced; missing var → empty string
  describe("env var substitution", () => {
    beforeEach(() => {
      process.env.__E2E_DISCORD_TOKEN = "live-token-xyz";
      delete process.env.__E2E_MISSING_VAR;
    });

    afterEach(() => {
      delete process.env.__E2E_DISCORD_TOKEN;
      delete process.env.__E2E_MISSING_VAR;
    });

    it("substitutes ${MY_VAR} in config and replaces missing var with empty string", () => {
      writeYaml(
        tmpDir,
        "config.yaml",
        `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are a helpful assistant."
    tools:
      - Bash
    sandboxed: false
channels:
  terminal:
    enabled: true
    agent: main
  discord:
    enabled: true
    token: \${__E2E_DISCORD_TOKEN}
    bindings:
      - server: "srv-1"
        agent: main
        channels: "*"
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "\${__E2E_MISSING_VAR}"
`
      );

      const { platform } = loadConfig(tmpDir);
      expect(platform.channels.discord!.token).toBe("live-token-xyz");
      // missing var resolved to empty string
      expect(platform.rbac.users.alice.identities.terminal).toBe("");
    });
  });

  // Test 5 — Agent config with credentials, store_keys, and container fields
  it("parses agent config with credentials, store_keys, and container fields", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  worker:
    model: claude-sonnet-4-20250514
    system: "You run sandboxed tasks."
    tools:
      - Bash
    sandboxed: false
    credentials:
      - GITHUB_TOKEN
      - OPENAI_API_KEY
    store_keys:
      - last_result
      - session_id
    container:
      dockerfile: "./docker/worker.Dockerfile"
      isolation: "session"
      memory: "2g"
      cpus: 2.0
      volumes:
        - "/tmp/work:/work"
channels:
  terminal:
    enabled: true
    agent: worker
  discord:
    enabled: true
    token: "test-discord-token"
    bindings:
      - server: "server-111"
        agent: worker
        channels: "*"
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
        - "tool:*"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "alice"
`
    );

    const { agents } = loadConfig(tmpDir);
    const worker = agents.agents.worker;

    expect(worker.credentials).toEqual(["GITHUB_TOKEN", "OPENAI_API_KEY"]);
    expect(worker.store_keys).toEqual(["last_result", "session_id"]);
    expect(worker.container).toBeDefined();
    expect(worker.container!.dockerfile).toBe("./docker/worker.Dockerfile");
    expect(worker.container!.isolation).toBe("session");
    expect(worker.container!.memory).toBe("2g");
    expect(worker.container!.cpus).toBe(2.0);
    expect(worker.container!.volumes).toEqual(["/tmp/work:/work"]);
  });
});

// ---------------------------------------------------------------------------
// ── CONFIG — negative ──
// ---------------------------------------------------------------------------

describe("Config — negative", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 6 — Non-existent config directory throws
  it("throws when config directory does not exist", () => {
    const nonExistentDir = join(tmpdir(), "absolutely-does-not-exist-e2e-" + Date.now());
    expect(() => loadConfig(nonExistentDir)).toThrow();
  });

  // Test 7 — Malformed YAML throws
  it("throws on malformed YAML syntax", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: [unclosed bracket
    system: "ok"
    tools: []
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

  // Test 8 — Missing required agent fields (model, system, tools) fail Zod validation
  it("throws Zod validation error when required agent fields are missing", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  broken:
    model: claude-sonnet-4-20250514
    # system is missing
    # tools is missing
channels:
  terminal:
    enabled: true
    agent: broken
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "alice"
`
    );

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  // Test 9 — Invalid container isolation value fails Zod validation
  it("throws Zod validation error for invalid container isolation value", () => {
    writeYaml(
      tmpDir,
      "config.yaml",
      `
agents:
  main:
    model: claude-sonnet-4-20250514
    system: "You are helpful."
    tools:
      - Bash
    container:
      isolation: "invalid"
channels:
  terminal:
    enabled: true
    agent: main
rbac:
  roles:
    owner:
      permissions:
        - "agent:*"
  users:
    alice:
      roles:
        - owner
      identities:
        terminal: "alice"
`
    );

    expect(() => loadConfig(tmpDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ── RBAC — positive ──
// ---------------------------------------------------------------------------

/**
 * Build a PlatformConfig that exercises owner / user role distinction,
 * with both terminal and discord identities defined.
 */
function buildRbacPlatformConfig(): PlatformConfig {
  return {
    channels: {
      terminal: { enabled: true, agent: "main" },
      discord: {
        enabled: true,
        token: "rbac-test-token",
        bindings: [
          { server: "srv-1", agent: "main", channels: "*" },
        ],
      },
    },
    rbac: {
      roles: {
        owner: { permissions: ["agent:*"] },
        user: {
          permissions: ["agent:main"],
          deny: ["tool:Bash", "tool:Write"],
          allow: ["tool:Bash:git *"],
        },
      },
      users: {
        alice: {
          roles: ["owner"],
          identities: { terminal: "alice", discord: "discord-alice" },
        },
        bob: {
          roles: ["user"],
          identities: { terminal: "bob", discord: "discord-bob" },
        },
      },
    },
  };
}

describe("RBAC — positive", () => {
  // Test 10 — Owner role with "agent:*" can access any agent
  it("owner with agent:* wildcard can access any agent", () => {
    const config = buildRbacPlatformConfig();

    expect(checkAccess("alice", "terminal", "main", config)).toBe(true);
    expect(checkAccess("alice", "terminal", "researcher", config)).toBe(true);
    expect(checkAccess("alice", "terminal", "anything-at-all", config)).toBe(true);
  });

  // Test 11 — User role with "agent:main" can access "main" agent
  it("user role with agent:main can access the main agent", () => {
    const config = buildRbacPlatformConfig();

    expect(checkAccess("bob", "terminal", "main", config)).toBe(true);
  });

  // Test 12 — Permission hook allows non-denied tools
  it("permission hook allows a tool that is not in the deny list", async () => {
    const config = buildRbacPlatformConfig();
    const hook = buildPermissionHook("bob", "terminal", config);

    // bob's deny list has Bash and Write, but not Read
    const result = await hook("Read", { path: "/tmp/some-file.txt" });
    expect(result.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// ── RBAC — negative ──
// ---------------------------------------------------------------------------

describe("RBAC — negative", () => {
  // Test 13 — User role with "agent:main" CANNOT access "researcher"
  it("user role with agent:main is denied access to researcher agent", () => {
    const config = buildRbacPlatformConfig();

    expect(checkAccess("bob", "terminal", "researcher", config)).toBe(false);
  });

  // Test 14 — Unknown user (not in users config) is denied
  it("unknown user not in users config is always denied", () => {
    const config = buildRbacPlatformConfig();

    expect(checkAccess("unknown-user-id", "terminal", "main", config)).toBe(false);
    expect(checkAccess("ghost", "discord", "main", config)).toBe(false);
  });

  // Test 15 — Permission hook denies tools in deny list
  it("permission hook denies tools that are in the deny list", async () => {
    const config = buildRbacPlatformConfig();
    // bob has deny: ["tool:Bash", "tool:Write"]
    const hook = buildPermissionHook("bob", "terminal", config);

    const bashResult = await hook("Bash", { command: "ls -la" });
    expect(bashResult.behavior).toBe("deny");

    const writeResult = await hook("Write", { path: "/tmp/file", content: "x" });
    expect(writeResult.behavior).toBe("deny");
  });

  // Test 15b — Allow exceptions override deny
  it("permission hook allows exceptions carved from deny rules", async () => {
    const config = buildRbacPlatformConfig();
    // bob has deny: ["tool:Bash"], allow: ["tool:Bash:git *"]
    const hook = buildPermissionHook("bob", "terminal", config);

    const gitResult = await hook("Bash", { command: "git status" });
    expect(gitResult.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// ── ROUTER — positive ──
// ---------------------------------------------------------------------------

function buildRouterPlatformConfig(): PlatformConfig {
  return {
    channels: {
      terminal: { enabled: true, agent: "main" },
      discord: {
        enabled: true,
        token: "router-test-token",
        bindings: [
          { server: "discord-server-100", agent: "main", channels: "*" },
          {
            server: "discord-server-200",
            agent: "researcher",
            channels: ["ch-general", "ch-research"],
          },
          {
            server: "discord-server-300",
            agent: "helper",
            channels: "ch-support",
          },
        ],
      },
    },
    rbac: { roles: {}, users: {} },
  };
}

describe("Router — positive", () => {
  // Test 16 — Terminal scope resolves to terminal agent
  it("terminal scope terminal:session:user resolves to terminal agent", () => {
    const config = buildRouterPlatformConfig();
    const agentId = resolveAgent("terminal:session-abc:user-xyz", config);
    expect(agentId).toBe("main");
  });

  // Test 17 — Discord scope resolves correctly when bindings match
  it("discord scope resolves correctly when a binding matches by wildcard", () => {
    const config = buildRouterPlatformConfig();
    // server-100 uses wildcard "*" — any channel resolves to 'main'
    expect(
      resolveAgent("discord:discord-server-100:any-channel-id:user-1", config)
    ).toBe("main");
  });

  it("discord scope resolves correctly when binding matches by channel array", () => {
    const config = buildRouterPlatformConfig();
    // server-200 lists specific channels
    expect(
      resolveAgent("discord:discord-server-200:ch-general:user-2", config)
    ).toBe("researcher");
    expect(
      resolveAgent("discord:discord-server-200:ch-research:user-2", config)
    ).toBe("researcher");
  });

  it("discord scope resolves correctly when binding matches by exact string channel", () => {
    const config = buildRouterPlatformConfig();
    // server-300 uses a single string channel
    expect(
      resolveAgent("discord:discord-server-300:ch-support:user-3", config)
    ).toBe("helper");
  });
});

// ---------------------------------------------------------------------------
// ── ROUTER — negative ──
// ---------------------------------------------------------------------------

describe("Router — negative", () => {
  // Test 18 — Unknown platform "sms:123" throws
  it("throws for completely unknown platform prefix (sms:123)", () => {
    const config = buildRouterPlatformConfig();
    expect(() => resolveAgent("sms:123:456", config)).toThrow(/Unknown platform/i);
  });

  // Test 19 — Discord scope with no matching binding throws
  it("throws when discord scope has no matching binding for the server/channel", () => {
    const config = buildRouterPlatformConfig();
    // server-200 does not cover ch-unknown
    expect(() =>
      resolveAgent("discord:discord-server-200:ch-unknown:user-1", config)
    ).toThrow(/No binding found/i);
  });

  // Test 20 — Terminal scope when terminal channel not configured throws
  it("throws when terminal scope is used but terminal channel is not configured", () => {
    const noTerminal: PlatformConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "tok",
          bindings: [{ server: "s1", agent: "main", channels: "*" }],
        },
      },
      rbac: { roles: {}, users: {} },
    };
    expect(() =>
      resolveAgent("terminal:session-abc:user-xyz", noTerminal)
    ).toThrow(/No terminal channel configured/i);
  });
});

// ---------------------------------------------------------------------------
// ── substituteEnvVars — standalone E2E coverage ──
// ---------------------------------------------------------------------------

describe("substituteEnvVars — direct coverage", () => {
  afterEach(() => {
    delete process.env.__E2E_SUBST_VAR;
    delete process.env.__E2E_ABSENT_VAR;
    delete process.env.__E2E_DEEP;
  });

  it("replaces a set env var and leaves surrounding text intact", () => {
    process.env.__E2E_SUBST_VAR = "hello-world";
    const result = substituteEnvVars("prefix-${__E2E_SUBST_VAR}-suffix");
    expect(result).toBe("prefix-hello-world-suffix");
  });

  it("replaces missing env var with empty string (not an error)", () => {
    delete process.env.__E2E_ABSENT_VAR;
    const result = substituteEnvVars("value=${__E2E_ABSENT_VAR}");
    expect(result).toBe("value=");
  });

  it("recurses into nested objects and arrays", () => {
    process.env.__E2E_DEEP = "deep-value";
    const result = substituteEnvVars({
      a: "${__E2E_DEEP}",
      b: ["${__E2E_DEEP}", "literal"],
      c: { nested: "${__E2E_DEEP}" },
    });
    expect(result).toEqual({
      a: "deep-value",
      b: ["deep-value", "literal"],
      c: { nested: "deep-value" },
    });
  });

  it("passes non-string primitives through unchanged", () => {
    expect(substituteEnvVars(42)).toBe(42);
    expect(substituteEnvVars(true)).toBe(true);
    expect(substituteEnvVars(null)).toBe(null);
  });
});
