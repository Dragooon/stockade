/**
 * E2E tests for the Terminal Channel pipeline.
 *
 * These tests exercise the full pipeline as a real user would experience it:
 *   config → router → RBAC → dispatch → Agent SDK → response → session persistence
 *
 * The Agent SDK is mocked via vi.mock() so tests are deterministic and require
 * no API key. Sessions use an in-memory SQLite database (better-sqlite3 ":memory:").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// ─── Mock the Agent SDK before any production imports that load it ───────────
const { mockQuery, mockTool, mockCreateSdkMcpServer } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTool: vi.fn(),
  mockCreateSdkMcpServer: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  tool: mockTool,
  createSdkMcpServer: mockCreateSdkMcpServer,
}));

// ─── Mock node:readline so TerminalAdapter.start() doesn't block stdin ───────
const mockRlOn = vi.fn();
const mockRlPrompt = vi.fn();
const mockRlClose = vi.fn();

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    on: mockRlOn,
    prompt: mockRlPrompt,
    close: mockRlClose,
  })),
}));

// ─── Mock node:crypto and node:os for TerminalAdapter scope construction ─────
vi.mock("node:crypto", () => ({
  randomUUID: () => "e2e-test-uuid",
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => ({ username: "mail" }),
  };
});

// ─── Now import all production modules (SDK mock is in place) ────────────────
import { loadConfig } from "../../src/config.js";
import { resolveAgent } from "../../src/router.js";
import { checkAccess, buildPermissionHook } from "../../src/rbac.js";
import {
  initSessionsTable,
  getSessionId,
  setSessionId,
} from "../../src/sessions.js";
import { dispatch, type DispatchContext } from "../../src/dispatcher.js";
import { TerminalAdapter } from "../../src/channels/terminal.js";
import type { ChannelMessage, PlatformConfig } from "../../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve path to test-terminal fixture relative to tests directory. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_CONFIG_DIR = resolve(__dirname, "../fixtures/test-terminal");

/** Create an async iterable from an array of SDK stream messages. */
function fakeStream(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

/** Standard SDK stream that returns a given result text and session ID. */
function makeStream(result: string, sessionId: string) {
  return fakeStream([
    { type: "system", session_id: sessionId },
    { type: "result", result, session_id: sessionId },
  ]);
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("E2E: Terminal Channel — positive scenarios", () => {
  // ── Scenario 1: Config loading ──────────────────────────────────────────────
  describe("Scenario 1: load test-terminal config", () => {
    it("parses config.yaml — main agent exists with expected fields", () => {
      const config = loadConfig(TEST_CONFIG_DIR);

      expect(config.agents.agents).toHaveProperty("main");
      const main = config.agents.agents.main;
      expect(main.model).toBe("sonnet");
      expect(main.tools).toContain("Bash");
      expect(main.sandboxed).toBe(false);
    });

    it("parses config.yaml — terminal channel enabled and bound to main", () => {
      const config = loadConfig(TEST_CONFIG_DIR);

      expect(config.platform.channels.terminal?.enabled).toBe(true);
      expect(config.platform.channels.terminal?.agent).toBe("main");
    });

    it("parses config.yaml — RBAC owner role has agent:* permission", () => {
      const config = loadConfig(TEST_CONFIG_DIR);

      expect(config.platform.rbac.roles.owner.permissions).toContain("agent:*");
    });

    it("parses config.yaml — user mail has owner role with terminal identity", () => {
      const config = loadConfig(TEST_CONFIG_DIR);

      expect(config.platform.rbac.users.mail.roles).toContain("owner");
      expect(config.platform.rbac.users.mail.identities.terminal).toBe("mail");
    });
  });

  // ── Scenario 2: Router — terminal scope → main agent ────────────────────────
  describe("Scenario 2: route terminal scope to 'main' agent", () => {
    let platform: PlatformConfig;

    beforeEach(() => {
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    it("resolves terminal scope to agent 'main'", () => {
      const agentId = resolveAgent("terminal:e2e-test-uuid:mail", platform);
      expect(agentId).toBe("main");
    });

    it("resolves regardless of the session UUID portion", () => {
      // All terminal scopes map to the configured agent
      expect(resolveAgent("terminal:aaaa-bbbb:mail", platform)).toBe("main");
      expect(resolveAgent("terminal:1234-5678:otheruser", platform)).toBe("main");
    });
  });

  // ── Scenario 3: RBAC — user "mail" with owner role ──────────────────────────
  describe("Scenario 3: RBAC check passes for user 'mail'", () => {
    let platform: PlatformConfig;

    beforeEach(() => {
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    it("checkAccess grants 'mail' access to agent 'main'", () => {
      expect(checkAccess("mail", "terminal", "main", platform)).toBe(true);
    });

    it("buildPermissionHook allows all tools for 'mail' (tool:* permission)", async () => {
      const hook = buildPermissionHook("mail", "terminal", platform);

      const bashResult = await hook("Bash", { command: "ls" });
      expect(bashResult.behavior).toBe("allow");

      const readResult = await hook("Read", { path: "/tmp/file" });
      expect(readResult.behavior).toBe("allow");

      const anyResult = await hook("AnyTool", {});
      expect(anyResult.behavior).toBe("allow");
    });
  });

  // ── Scenario 4: Full dispatch cycle ─────────────────────────────────────────
  describe("Scenario 4: full dispatch cycle — message → SDK response → session stored", () => {
    let db: Database.Database;
    let platform: PlatformConfig;

    beforeEach(() => {
      vi.clearAllMocks();
      db = new Database(":memory:");
      initSessionsTable(db);
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    afterEach(() => {
      db.close();
    });

    it("dispatches message to SDK and stores returned session ID", async () => {
      mockQuery.mockReturnValue(makeStream("Hello from main!", "sdk-sess-001"));

      const { agents } = loadConfig(TEST_CONFIG_DIR);
      const scope = "terminal:e2e-test-uuid:mail";
      const msg: ChannelMessage = {
        scope,
        content: "Hello agent",
        userId: "mail",
        platform: "terminal",
      };

      const agentId = resolveAgent(scope, platform);
      expect(agentId).toBe("main");

      expect(checkAccess(msg.userId, msg.platform, agentId, platform)).toBe(true);

      const agentConfig = agents.agents[agentId];
      const sessionId = getSessionId(db, scope); // null initially
      expect(sessionId).toBeNull();

      const permissionHook = buildPermissionHook(msg.userId, msg.platform, platform);
      const context: DispatchContext = {
        allAgents: agents,
        platform,
        userId: msg.userId,
        userPlatform: msg.platform,
      };

      const result = await dispatch(agentId, msg, agentConfig, sessionId, permissionHook, context);

      expect(result.result).toBe("Hello from main!");
      expect(result.sessionId).toBe("sdk-sess-001");

      // Store session
      setSessionId(db, scope, result.sessionId);
      expect(getSessionId(db, scope)).toBe("sdk-sess-001");
    });

    it("SDK query is called with correct model, system, tools, and no resume on first call", async () => {
      mockQuery.mockReturnValue(makeStream("First response", "sdk-sess-002"));

      const { agents } = loadConfig(TEST_CONFIG_DIR);
      const scope = "terminal:e2e-test-uuid:mail";
      const msg: ChannelMessage = {
        scope,
        content: "What is 2+2?",
        userId: "mail",
        platform: "terminal",
      };

      await dispatch("main", msg, agents.agents.main, null, undefined, undefined);

      expect(mockQuery).toHaveBeenCalledOnce();
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.prompt).toBe("What is 2+2?");
      expect(callArgs.options.model).toBe("sonnet");
      expect(callArgs.options.systemPrompt).toContain("helpful assistant");
      expect(callArgs.options.tools).toContain("Bash");
      expect(callArgs.options.resume).toBeUndefined();
    });
  });

  // ── Scenario 5: Session resume ───────────────────────────────────────────────
  describe("Scenario 5: session resume — second message reuses stored sessionId", () => {
    let db: Database.Database;
    let platform: PlatformConfig;

    beforeEach(() => {
      vi.clearAllMocks();
      db = new Database(":memory:");
      initSessionsTable(db);
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    afterEach(() => {
      db.close();
    });

    it("second dispatch call passes the stored sessionId as 'resume'", async () => {
      const { agents } = loadConfig(TEST_CONFIG_DIR);
      const scope = "terminal:e2e-test-uuid:mail";

      // ── First message: no session yet ──
      mockQuery.mockReturnValueOnce(makeStream("First reply", "sdk-sess-100"));

      const msg1: ChannelMessage = {
        scope,
        content: "First message",
        userId: "mail",
        platform: "terminal",
      };

      const result1 = await dispatch("main", msg1, agents.agents.main, null);
      expect(result1.sessionId).toBe("sdk-sess-100");

      // Store the session as handleMessage would
      setSessionId(db, scope, result1.sessionId);

      // ── Second message: session exists, should resume ──
      mockQuery.mockReturnValueOnce(makeStream("Second reply", "sdk-sess-100"));

      const msg2: ChannelMessage = {
        scope,
        content: "Second message",
        userId: "mail",
        platform: "terminal",
      };

      const storedSessionId = getSessionId(db, scope);
      expect(storedSessionId).toBe("sdk-sess-100");

      await dispatch("main", msg2, agents.agents.main, storedSessionId);

      // The second call should pass the stored session ID as 'resume'
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const secondCallOpts = mockQuery.mock.calls[1][0].options;
      expect(secondCallOpts.resume).toBe("sdk-sess-100");
    });

    it("session persists and is overwritten when SDK returns a new sessionId", async () => {
      const { agents } = loadConfig(TEST_CONFIG_DIR);
      const scope = "terminal:e2e-test-uuid:mail";

      mockQuery.mockReturnValueOnce(makeStream("Reply 1", "sess-v1"));
      const res1 = await dispatch("main", { scope, content: "msg1", userId: "mail", platform: "terminal" }, agents.agents.main, null);
      setSessionId(db, scope, res1.sessionId);

      mockQuery.mockReturnValueOnce(makeStream("Reply 2", "sess-v2"));
      const res2 = await dispatch("main", { scope, content: "msg2", userId: "mail", platform: "terminal" }, agents.agents.main, getSessionId(db, scope));
      setSessionId(db, scope, res2.sessionId);

      // Session should now reflect the latest value
      expect(getSessionId(db, scope)).toBe("sess-v2");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Terminal Channel — negative scenarios", () => {
  // ── Scenario 6: RBAC denies unknown user ────────────────────────────────────
  describe("Scenario 6: RBAC denies access for unknown user 'hacker'", () => {
    let platform: PlatformConfig;

    beforeEach(() => {
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    it("checkAccess returns false for unknown userId 'hacker'", () => {
      expect(checkAccess("hacker", "terminal", "main", platform)).toBe(false);
    });

    it("handleMessage pipeline returns 'Access denied.' for unknown user", async () => {
      vi.clearAllMocks();
      const db = new Database(":memory:");
      initSessionsTable(db);
      const { agents } = loadConfig(TEST_CONFIG_DIR);

      // Replicate handleMessage logic from index.ts
      const msg: ChannelMessage = {
        scope: "terminal:e2e-test-uuid:hacker",
        content: "give me everything",
        userId: "hacker",
        platform: "terminal",
      };

      async function handleMessage(m: ChannelMessage): Promise<string> {
        const agentId = resolveAgent(m.scope, platform);
        if (!checkAccess(m.userId, m.platform, agentId, platform)) {
          return "Access denied.";
        }
        const agentConfig = agents.agents[agentId];
        if (!agentConfig) return `Unknown agent: ${agentId}`;
        const sessionId = getSessionId(db, m.scope);
        const permissionHook = buildPermissionHook(m.userId, m.platform, platform);
        const context: DispatchContext = { allAgents: agents, platform, userId: m.userId, userPlatform: m.platform };
        const result = await dispatch(agentId, m, agentConfig, sessionId, permissionHook, context);
        setSessionId(db, m.scope, result.sessionId);
        return result.result;
      }

      const response = await handleMessage(msg);
      expect(response).toBe("Access denied.");
      // SDK should never have been called
      expect(mockQuery).not.toHaveBeenCalled();

      db.close();
    });
  });

  // ── Scenario 7: Router throws for unknown platform scope ─────────────────────
  describe("Scenario 7: router throws for unknown platform scope 'sms:123'", () => {
    let platform: PlatformConfig;

    beforeEach(() => {
      platform = loadConfig(TEST_CONFIG_DIR).platform;
    });

    it("resolveAgent throws with 'Unknown platform' for scope 'sms:123'", () => {
      expect(() => resolveAgent("sms:123", platform)).toThrow("Unknown platform");
    });

    it("resolveAgent throws for scope 'slack:workspace:channel'", () => {
      expect(() => resolveAgent("slack:workspace:channel", platform)).toThrow("Unknown platform");
    });
  });

  // ── Scenario 8: Dispatch to non-existent agent returns error ─────────────────
  describe("Scenario 8: dispatch to non-existent agent returns error message", () => {
    it("handleMessage returns 'Unknown agent:' message when agentId not in config", async () => {
      vi.clearAllMocks();
      const db = new Database(":memory:");
      initSessionsTable(db);
      const { agents } = loadConfig(TEST_CONFIG_DIR);

      // Create a platform config that routes terminal to a non-existent agent
      const brokenPlatform: PlatformConfig = {
        ...loadConfig(TEST_CONFIG_DIR).platform,
        channels: {
          terminal: { enabled: true, agent: "ghost-agent" },
        },
      };

      async function handleMessage(m: ChannelMessage): Promise<string> {
        const agentId = resolveAgent(m.scope, brokenPlatform);
        if (!checkAccess(m.userId, m.platform, agentId, brokenPlatform)) {
          return "Access denied.";
        }
        const agentConfig = agents.agents[agentId];
        if (!agentConfig) return `Unknown agent: ${agentId}`;
        const sessionId = getSessionId(db, m.scope);
        const permissionHook = buildPermissionHook(m.userId, m.platform, brokenPlatform);
        const context: DispatchContext = { allAgents: agents, platform: brokenPlatform, userId: m.userId, userPlatform: m.platform };
        const result = await dispatch(agentId, m, agentConfig, sessionId, permissionHook, context);
        setSessionId(db, m.scope, result.sessionId);
        return result.result;
      }

      const msg: ChannelMessage = {
        scope: "terminal:e2e-test-uuid:mail",
        content: "Hello?",
        userId: "mail",
        platform: "terminal",
      };

      const response = await handleMessage(msg);
      expect(response).toBe("Unknown agent: ghost-agent");
      expect(mockQuery).not.toHaveBeenCalled();

      db.close();
    });
  });

  // ── Scenario 9: Empty message is ignored by TerminalAdapter ──────────────────
  describe("Scenario 9: TerminalAdapter ignores empty message content", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("does not call onMessage for an empty (whitespace-only) line", async () => {
      const onMessage = vi.fn().mockResolvedValue("Should not be called");
      const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
      adapter.start();

      // Extract the line handler registered via rl.on("line", ...)
      const lineHandler = mockRlOn.mock.calls.find(
        (call) => call[0] === "line"
      )![1] as (line: string) => Promise<void>;

      await lineHandler("   ");
      expect(onMessage).not.toHaveBeenCalled();

      await lineHandler("");
      expect(onMessage).not.toHaveBeenCalled();

      await lineHandler("\t\t");
      expect(onMessage).not.toHaveBeenCalled();

      adapter.stop();
    });

    it("calls onMessage for non-empty content (control: adapter is wired)", async () => {
      vi.clearAllMocks();
      mockQuery.mockReturnValue(makeStream("Got it!", "sess-empty-test"));

      const { agents, platform } = loadConfig(TEST_CONFIG_DIR);
      const db = new Database(":memory:");
      initSessionsTable(db);

      async function handleMessage(msg: ChannelMessage): Promise<string> {
        const agentId = resolveAgent(msg.scope, platform);
        if (!checkAccess(msg.userId, msg.platform, agentId, platform)) return "Access denied.";
        const agentConfig = agents.agents[agentId];
        if (!agentConfig) return `Unknown agent: ${agentId}`;
        const sessionId = getSessionId(db, msg.scope);
        const permissionHook = buildPermissionHook(msg.userId, msg.platform, platform);
        const context: DispatchContext = { allAgents: agents, platform, userId: msg.userId, userPlatform: msg.platform };
        const result = await dispatch(agentId, msg, agentConfig, sessionId, permissionHook, context);
        setSessionId(db, msg.scope, result.sessionId);
        return result.result;
      }

      const onMessage = vi.fn().mockImplementation(handleMessage);
      const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
      adapter.start();

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const lineHandler = mockRlOn.mock.calls.find(
        (call) => call[0] === "line"
      )![1] as (line: string) => Promise<void>;

      await lineHandler("Hello agent");
      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Hello agent",
          userId: "mail",
          platform: "terminal",
        }),
        expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
      );

      writeSpy.mockRestore();
      adapter.stop();
      db.close();
    });
  });

  // ── Scenario 10: Config loading fails for non-existent directory ──────────────
  describe("Scenario 10: config loading fails for non-existent config directory", () => {
    it("throws when config directory does not exist", () => {
      const nonExistentDir = "/absolutely/nonexistent/config/dir/xyz";
      expect(() => loadConfig(nonExistentDir)).toThrow();
    });

    it("throws when config.yaml is missing from an otherwise valid directory", () => {
      // The test-terminal dir has config.yaml, so use a path that has none
      const bogusDir = resolve(__dirname, "../../../../config/does-not-exist");
      expect(() => loadConfig(bogusDir)).toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: Terminal Channel — full pipeline integration (handleMessage wired)", () => {
  /**
   * This suite wires everything together exactly as index.ts does it:
   * real config, real router, real RBAC, real sessions, mocked SDK.
   */
  let db: Database.Database;
  let platform: PlatformConfig;

  function buildHandleMessage(db: Database.Database, platform: PlatformConfig) {
    const { agents } = loadConfig(TEST_CONFIG_DIR);

    return async function handleMessage(msg: ChannelMessage): Promise<string> {
      const agentId = resolveAgent(msg.scope, platform);

      if (!checkAccess(msg.userId, msg.platform, agentId, platform)) {
        return "Access denied.";
      }

      const agentConfig = agents.agents[agentId];
      if (!agentConfig) {
        return `Unknown agent: ${agentId}`;
      }

      const sessionId = getSessionId(db, msg.scope);
      const permissionHook = buildPermissionHook(msg.userId, msg.platform, platform);
      const context: DispatchContext = {
        allAgents: agents,
        platform,
        userId: msg.userId,
        userPlatform: msg.platform,
      };

      const result = await dispatch(agentId, msg, agentConfig, sessionId, permissionHook, context);
      setSessionId(db, msg.scope, result.sessionId);
      return result.result;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(":memory:");
    initSessionsTable(db);
    platform = loadConfig(TEST_CONFIG_DIR).platform;
  });

  afterEach(() => {
    db.close();
  });

  it("complete happy path: terminal message → response → session stored", async () => {
    mockQuery.mockReturnValue(makeStream("All systems go!", "full-pipe-sess-1"));

    const handleMessage = buildHandleMessage(db, platform);
    const scope = "terminal:e2e-test-uuid:mail";

    const response = await handleMessage({
      scope,
      content: "Status check",
      userId: "mail",
      platform: "terminal",
    });

    expect(response).toBe("All systems go!");
    expect(getSessionId(db, scope)).toBe("full-pipe-sess-1");
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("complete conversation: two messages share session state", async () => {
    const scope = "terminal:e2e-test-uuid:mail";
    const handleMessage = buildHandleMessage(db, platform);

    // Turn 1
    mockQuery.mockReturnValueOnce(makeStream("Turn 1 reply", "conv-sess-1"));
    await handleMessage({ scope, content: "Turn 1", userId: "mail", platform: "terminal" });
    expect(getSessionId(db, scope)).toBe("conv-sess-1");

    // Turn 2 — session should be resumed
    mockQuery.mockReturnValueOnce(makeStream("Turn 2 reply", "conv-sess-1"));
    const reply2 = await handleMessage({ scope, content: "Turn 2", userId: "mail", platform: "terminal" });

    expect(reply2).toBe("Turn 2 reply");
    const turn2Opts = mockQuery.mock.calls[1][0].options;
    expect(turn2Opts.resume).toBe("conv-sess-1");
  });

  it("different scopes maintain independent sessions", async () => {
    const scope1 = "terminal:e2e-session-a:mail";
    const scope2 = "terminal:e2e-session-b:mail";
    const handleMessage = buildHandleMessage(db, platform);

    mockQuery.mockReturnValueOnce(makeStream("Reply A", "sess-A"));
    mockQuery.mockReturnValueOnce(makeStream("Reply B", "sess-B"));

    await handleMessage({ scope: scope1, content: "Hello from A", userId: "mail", platform: "terminal" });
    await handleMessage({ scope: scope2, content: "Hello from B", userId: "mail", platform: "terminal" });

    expect(getSessionId(db, scope1)).toBe("sess-A");
    expect(getSessionId(db, scope2)).toBe("sess-B");
  });

  it("unauthorized user is denied at RBAC gate, SDK not called", async () => {
    const handleMessage = buildHandleMessage(db, platform);

    const response = await handleMessage({
      scope: "terminal:e2e-test-uuid:hacker",
      content: "I should not get through",
      userId: "hacker",
      platform: "terminal",
    });

    expect(response).toBe("Access denied.");
    expect(mockQuery).not.toHaveBeenCalled();
    // No session stored for denied user
    expect(getSessionId(db, "terminal:e2e-test-uuid:hacker")).toBeNull();
  });
});
