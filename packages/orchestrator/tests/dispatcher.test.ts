import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import type {
  AgentConfig,
  AgentsConfig,
  ChannelMessage,
  PlatformConfig,
} from "../src/types.js";
import type { DispatchContext } from "../src/dispatcher.js";

// Mock the Agent SDK before importing dispatcher
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

// Mock global fetch for sandboxed dispatch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { dispatch, buildSystemPrompt, buildSdkSettings, PLATFORM_DISALLOWED_TOOLS, SELF_MODIFICATION_DENY_RULES } = await import("../src/dispatcher.js");

/** Helper: create an async iterable from an array of messages */
function fakeStream(messages: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

const baseMessage: ChannelMessage = {
  scope: "terminal:uuid:alice",
  content: "Hello, agent!",
  userId: "alice",
  platform: "terminal",
};

const localAgent: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "You are helpful.",
  tools: ["Bash", "Read"],
  sandboxed: false,
};

const sandboxedAgent: AgentConfig = {
  model: "claude-haiku-4-5-20251001",
  system: "You research.",
  tools: ["WebSearch"],
  sandboxed: true,
  port: 3001,
  url: "http://localhost:3001",
};

const agentWithSubagents: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  system: "You can delegate to sub-agents.",
  tools: ["Bash", "Read"],
  sandboxed: false,
  subagents: ["researcher"],
};

const allAgents: AgentsConfig = {
  agents: {
    main: agentWithSubagents,
    researcher: sandboxedAgent,
  },
};

const platformConfig: PlatformConfig = {
  channels: {
    terminal: { enabled: true, agent: "main" },
  },
  rbac: {
    roles: {
      owner: { permissions: ["agent:*", "tool:*"] },
      user: { permissions: ["agent:main"] },
    },
    users: {
      alice: {
        roles: ["owner"],
        identities: { terminal: "alice" },
      },
      bob: {
        roles: ["user"],
        identities: { terminal: "bob" },
      },
    },
  },
};

const ownerContext: DispatchContext = {
  allAgents,
  platform: platformConfig,
  userId: "alice",
  userPlatform: "terminal",
};

const restrictedContext: DispatchContext = {
  allAgents,
  platform: platformConfig,
  userId: "bob",
  userPlatform: "terminal",
};

describe("dispatch — in-process (local)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Agent SDK query and returns result + sessionId", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-local-1" },
        { type: "assistant", content: "thinking..." },
        { type: "result", result: "Hello back!", session_id: "sess-local-1" },
      ])
    );

    const result = await dispatch("main", baseMessage, localAgent, null);

    expect(result.result).toBe("Hello back!");
    expect(result.sessionId).toBe("sess-local-1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hello, agent!",
        options: expect.objectContaining({
          model: "claude-sonnet-4-20250514",
          systemPrompt: "You are helpful.",
          tools: ["Bash", "Read"],
          maxTurns: 20,
        }),
      })
    );
    // No resume when sessionId is null
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.resume).toBeUndefined();

    // Platform isolation options
    expect(opts.settingSources).toEqual(["project"]);
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts.disallowedTools).toEqual(["Agent", "WebSearch"]);
    expect(opts.settings).toBeDefined();
    expect(opts.settings.permissions.deny).toContain("Agent");
    // Self-modification deny rules
    expect(opts.settings.permissions.deny).toContain("Write(.claude/**)");
    expect(opts.settings.permissions.deny).toContain("Edit(.claude/**)");
    expect(opts.settings.permissions.deny).not.toContain("Write(CLAUDE.md)");
    expect(opts.settings.permissions.deny).not.toContain("Edit(CLAUDE.md)");
  });

  it("passes existing sessionId for resume", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-resumed" },
        { type: "result", result: "Resumed!" },
      ])
    );

    await dispatch("main", baseMessage, localAgent, "sess-existing");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: "sess-existing",
        }),
      })
    );
  });

  it("passes effort level when configured", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-effort" },
        { type: "result", result: "Done" },
      ])
    );

    const agentWithEffort: AgentConfig = { ...localAgent, effort: "max" };
    await dispatch("main", baseMessage, agentWithEffort, null);

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.effort).toBe("max");
  });

  it("omits effort when not configured", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-no-effort" },
        { type: "result", result: "Done" },
      ])
    );

    await dispatch("main", baseMessage, localAgent, null);

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.effort).toBeUndefined();
  });

  it("injects memory settings into SDK settings", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-mem" },
        { type: "result", result: "Done" },
      ])
    );

    const agentWithMemory: AgentConfig = {
      ...localAgent,
      memory: { enabled: true, autoDream: true },
    };
    const context: DispatchContext = {
      allAgents,
      platform: platformConfig,
      userId: "alice",
      userPlatform: "terminal",
      agentsDir: "/data/agents",
    };

    await dispatch("main", baseMessage, agentWithMemory, null, undefined, context);

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.settings.autoMemoryEnabled).toBe(true);
    expect(opts.settings.autoDreamEnabled).toBe(true);
    expect(opts.settings.autoMemoryDirectory).toBe(join("/data/agents", "main", "memory"));
  });

  it("disables memory when memory.enabled is false", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-nomem" },
        { type: "result", result: "Done" },
      ])
    );

    const agentNoMem: AgentConfig = {
      ...localAgent,
      memory: { enabled: false },
    };
    await dispatch("main", baseMessage, agentNoMem, null);

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.settings.autoMemoryEnabled).toBe(false);
    expect(opts.settings.autoDreamEnabled).toBe(false);
  });

  it("strips Agent from tools list", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-strip" },
        { type: "result", result: "Done" },
      ])
    );

    const agentWithAgentTool: AgentConfig = {
      ...localAgent,
      tools: ["Bash", "Agent", "Read"],
    };
    await dispatch("main", baseMessage, agentWithAgentTool, null);

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.tools).toEqual(["Bash", "Read"]);
    // Also hard-denied at SDK level
    expect(opts.disallowedTools).toEqual(["Agent", "WebSearch"]);
  });

  it("passes permission hook as PreToolUse hook", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-perm" },
        { type: "result", result: "Done" },
      ])
    );

    const hook = vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} });
    await dispatch("main", baseMessage, localAgent, null, hook);

    const opts = mockQuery.mock.calls[0][0].options;
    // Permission hook is wired as a PreToolUse hook (not canUseTool)
    expect(opts.hooks).toBeDefined();
    expect(opts.hooks.PreToolUse).toHaveLength(1);
    expect(opts.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });
});

describe("dispatch — sub-agent MCP integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up tool() mock to capture the handler and return a sentinel
    mockTool.mockImplementation(
      (name: string, _desc: string, _schema: unknown, handler: Function) => ({
        __mockTool: true,
        name,
        handler,
      })
    );
    mockCreateSdkMcpServer.mockReturnValue({ __mockMcpServer: true });
  });

  it("creates MCP server when agent has subagents and context is provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    await dispatch(
      "main",
      baseMessage,
      agentWithSubagents,
      null,
      undefined,
      ownerContext
    );

    // Verify MCP server was created
    expect(mockCreateSdkMcpServer).toHaveBeenCalledWith({
      name: "orchestrator",
      version: "1.0.0",
      tools: [expect.objectContaining({ name: "ask_agent" })],
    });

    // Verify mcpServers was passed to query options
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.mcpServers).toEqual({
      orchestrator: { __mockMcpServer: true },
    });

    // Verify ask_agent tool was added to tools list
    expect(opts.tools).toEqual([
      "Bash",
      "Read",
      "mcp__orchestrator__ask_agent",
    ]);
  });

  it("does NOT create MCP server when agent has no subagents", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    await dispatch("main", baseMessage, localAgent, null, undefined, ownerContext);

    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.tools).toEqual(["Bash", "Read"]);
  });

  it("does NOT create MCP server when context is missing", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    await dispatch("main", baseMessage, agentWithSubagents, null);

    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  it("ask_agent handler dispatches to sandboxed sub-agent via fetch", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    // Set up fetch mock for the sandboxed sub-agent
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: "Research findings here",
        sessionId: "sess-sub-1",
      }),
    });

    await dispatch(
      "main",
      baseMessage,
      agentWithSubagents,
      null,
      undefined,
      ownerContext
    );

    // Get the ask_agent handler that was passed to tool()
    const toolCall = mockTool.mock.calls[0];
    const handler = toolCall[3];

    // Invoke the handler as if the agent called ask_agent
    const result = await handler({ agentId: "researcher", task: "Find info on X" });

    // Should have dispatched to the sandboxed researcher via fetch
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/run",
      expect.objectContaining({ method: "POST" })
    );

    // Result should contain the sandboxed agent's response
    expect(result).toEqual({
      content: [{ type: "text", text: "Research findings here" }],
    });
  });

  it("ask_agent handler denies access for unauthorized user", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    // bob only has agent:main, not agent:researcher
    await dispatch(
      "main",
      { ...baseMessage, userId: "bob" },
      agentWithSubagents,
      null,
      undefined,
      restrictedContext
    );

    const handler = mockTool.mock.calls[0][3];
    const result = await handler({ agentId: "researcher", task: "Find info" });

    expect(result).toEqual({
      content: [
        { type: "text", text: 'Access denied: user cannot invoke agent "researcher"' },
      ],
    });
    // Should NOT have dispatched
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ask_agent handler returns error for unknown agent", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "sess-1" },
        { type: "result", result: "Done" },
      ])
    );

    await dispatch(
      "main",
      baseMessage,
      agentWithSubagents,
      null,
      undefined,
      ownerContext
    );

    const handler = mockTool.mock.calls[0][3];
    const result = await handler({ agentId: "nonexistent", task: "Do something" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Unknown agent: nonexistent" }],
    });
  });
});

describe("dispatch — sandboxed (HTTP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs to worker URL and returns result", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: "Remote result",
        sessionId: "sess-sandboxed-1",
      }),
    });

    const result = await dispatch(
      "researcher",
      baseMessage,
      sandboxedAgent,
      null
    );

    expect(result.result).toBe("Remote result");
    expect(result.sessionId).toBe("sess-sandboxed-1");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/run",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    // Verify the body
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.prompt).toBe("Hello, agent!");
    expect(callBody.model).toBe("claude-haiku-4-5-20251001");
    expect(callBody.tools).toEqual(["WebSearch"]);
  });

  it("passes sessionId for sandboxed resume", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: "Resumed in sandbox",
        sessionId: "sess-sandboxed-2",
      }),
    });

    await dispatch(
      "researcher",
      baseMessage,
      sandboxedAgent,
      "sess-existing-sandboxed"
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.sessionId).toBe("sess-existing-sandboxed");
  });

  it("falls back to port-based URL when url is not set", async () => {
    const agentNoUrl: AgentConfig = {
      ...sandboxedAgent,
      url: undefined,
      port: 4000,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "sess-3" }),
    });

    await dispatch("researcher", baseMessage, agentNoUrl, null);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4000/run",
      expect.anything()
    );
  });

  it("throws on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      dispatch("researcher", baseMessage, sandboxedAgent, null)
    ).rejects.toThrow("Worker responded with 500");
  });

  it("propagates fetch network errors (ECONNREFUSED)", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      dispatch("researcher", baseMessage, sandboxedAgent, null)
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("uses buildSystemPrompt for remote dispatch (flattens append mode to string)", async () => {
    const appendAgent: AgentConfig = {
      ...sandboxedAgent,
      system_mode: "append",
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "s-1" }),
    });

    await dispatch("researcher", baseMessage, appendAgent, null);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Remote workers only accept string — append mode is flattened to the raw text.
    // Platform instructions (network policy for sandboxed agents) are appended.
    expect(callBody.systemPrompt).toContain("You research.");
    expect(callBody.systemPrompt).toContain("Network Policy");
  });

});

describe("dispatch — container manager integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls containerManager.ensure() and dispatches to returned URL", async () => {
    const mockEnsure = vi.fn().mockResolvedValue("http://localhost:4444");
    const containerManager = { ensure: mockEnsure } as any;

    const sandboxedNoUrl: AgentConfig = {
      model: "claude-haiku-4-5-20251001",
      system: "You research.",
      tools: ["WebSearch"],
      sandboxed: true,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "Container result", sessionId: "s-1" }),
    });

    const result = await dispatch(
      "researcher",
      baseMessage,
      sandboxedNoUrl,
      null,
      undefined,
      undefined,
      containerManager
    );

    expect(mockEnsure).toHaveBeenCalledWith(
      "researcher",
      sandboxedNoUrl,
      baseMessage.scope
    );
    expect(result.result).toBe("Container result");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4444/run",
      expect.anything()
    );
  });

  it("falls back to standard sandboxed dispatch without containerManager", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "Standard", sessionId: "s-2" }),
    });

    const result = await dispatch(
      "researcher",
      baseMessage,
      sandboxedAgent,
      null
    );

    expect(result.result).toBe("Standard");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/run",
      expect.anything()
    );
  });

  it("does not call containerManager for local agents", async () => {
    const mockEnsure = vi.fn();
    const containerManager = { ensure: mockEnsure } as any;

    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", session_id: "s-local" },
        { type: "result", result: "Local result" },
      ])
    );

    const result = await dispatch(
      "main",
      baseMessage,
      localAgent,
      null,
      undefined,
      undefined,
      containerManager
    );

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(result.result).toBe("Local result");
  });
});

describe("dispatch — streaming error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates error thrown mid-stream instead of swallowing it", async () => {
    // Create a stream that yields a system message then throws mid-iteration
    const errorStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", session_id: "sess-err" };
        throw new Error("stream connection lost");
      },
    };

    mockQuery.mockReturnValue(errorStream);

    await expect(
      dispatch("main", baseMessage, localAgent, null)
    ).rejects.toThrow("stream connection lost");
  });
});

// ── buildSystemPrompt ────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("returns plain string in replace mode (default)", () => {
    const agent: AgentConfig = { model: "sonnet", system: "You are helpful." };
    const result = buildSystemPrompt(agent);
    expect(result).toBe("You are helpful.");
  });

  it("returns preset object in append mode", () => {
    const agent: AgentConfig = { model: "sonnet", system: "Custom instructions.", system_mode: "append" };
    const result = buildSystemPrompt(agent);
    expect(result).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Custom instructions.",
    });
  });

  it("returns undefined when no system prompt", () => {
    const agent: AgentConfig = { model: "sonnet", system: "" };
    const result = buildSystemPrompt(agent);
    expect(result).toBeUndefined();
  });
});

// ── buildSdkSettings ─────────────────────────────────────────────────────────

describe("buildSdkSettings", () => {
  it("returns default memory settings when no memory config", () => {
    const agent: AgentConfig = { model: "sonnet", system: "test" };
    const settings = buildSdkSettings(agent, "main");

    expect(settings.autoMemoryEnabled).toBe(true);
    expect(settings.autoDreamEnabled).toBe(false);
    expect(settings.autoMemoryDirectory).toBeUndefined();
  });

  it("computes memory directory from agentsDir", () => {
    const agent: AgentConfig = { model: "sonnet", system: "test" };
    const settings = buildSdkSettings(agent, "main", "/data/agents");

    expect(settings.autoMemoryDirectory).toBe(join("/data/agents", "main", "memory"));
  });

  it("respects memory.enabled = false", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "test",
      memory: { enabled: false },
    };
    const settings = buildSdkSettings(agent, "main");

    expect(settings.autoMemoryEnabled).toBe(false);
  });

  it("respects memory.autoDream = true", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "test",
      memory: { enabled: true, autoDream: true },
    };
    const settings = buildSdkSettings(agent, "main");

    expect(settings.autoDreamEnabled).toBe(true);
  });

  it("denies Agent tool in settings permissions", () => {
    const agent: AgentConfig = { model: "sonnet", system: "test" };
    const settings = buildSdkSettings(agent, "main");

    expect((settings.permissions as any).deny).toContain("Agent");
  });

  it("denies self-modification of .claude/", () => {
    const agent: AgentConfig = { model: "sonnet", system: "test" };
    const settings = buildSdkSettings(agent, "main");
    const deny = (settings.permissions as any).deny as string[];

    for (const rule of SELF_MODIFICATION_DENY_RULES) {
      expect(deny).toContain(rule);
    }
  });
});

// ── PLATFORM_DISALLOWED_TOOLS ────────────────────────────────────────────────

describe("PLATFORM_DISALLOWED_TOOLS", () => {
  it("includes Agent tool", () => {
    expect(PLATFORM_DISALLOWED_TOOLS).toContain("Agent");
  });
});

// ── remote dispatch — effort passthrough ─────────────────────────────────────

describe("dispatch — remote effort passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes effort in remote dispatch body", async () => {
    const agentWithEffort: AgentConfig = {
      ...sandboxedAgent,
      effort: "low",
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "s-1" }),
    });

    await dispatch("researcher", baseMessage, agentWithEffort, null);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.effort).toBe("low");
  });

  it("omits effort from remote dispatch body when not configured", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "s-1" }),
    });

    await dispatch("researcher", baseMessage, sandboxedAgent, null);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.effort).toBeUndefined();
  });

  it("strips Agent from tools in remote dispatch body", async () => {
    const agentWithAgentTool: AgentConfig = {
      ...sandboxedAgent,
      tools: ["WebSearch", "Agent"],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: "ok", sessionId: "s-1" }),
    });

    await dispatch("researcher", baseMessage, agentWithAgentTool, null);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.tools).toEqual(["WebSearch"]);
  });
});
