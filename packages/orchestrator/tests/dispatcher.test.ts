import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type {
  AgentConfig,
  AgentsConfig,
  ChannelMessage,
  PlatformConfig,
} from "../src/types.js";
import type { DispatchContext } from "../src/dispatcher.js";

// Mock global fetch — the dispatcher communicates with workers via HTTP
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock the sessions registry (avoid real state between tests)
vi.mock("../src/api/sessions.js", () => ({
  createCallbackSession: vi.fn(),
  deleteCallbackSession: vi.fn(),
  getCallbackSession: vi.fn(),
}));

// Mock agent-mcp (registerRunSession)
vi.mock("../src/agent-mcp.js", () => ({
  registerRunSession: vi.fn(),
  handleAgentStart: vi.fn(),
  handleAgentStop: vi.fn(),
  handleAgentMessage: vi.fn(),
}));

const {
  dispatch,
  buildSystemPrompt,
  buildSdkSettings,
  PLATFORM_DISALLOWED_TOOLS,
  SELF_MODIFICATION_DENY_RULES,
} = await import("../src/dispatcher.js");

// ── Test fixtures ────────────────────────────────────────────────────────────

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
};

const allAgents: AgentsConfig = {
  agents: { main: localAgent, researcher: sandboxedAgent },
};

const platformConfig: PlatformConfig = {
  channels: { terminal: { enabled: true, agent: "main" } },
  rbac: {
    roles: {
      owner: { permissions: ["agent:*", "tool:*"] },
    },
    users: {
      alice: { roles: ["owner"], identities: { terminal: "alice" } },
    },
  },
};

/** Minimal WorkerManager mock */
function makeWorkerManager(url = "http://localhost:4001") {
  return {
    ensure: vi.fn().mockResolvedValue(url),
    restart: vi.fn(),
    shutdownAll: vi.fn(),
    cleanupOrphans: vi.fn(),
    resolveMemoryPath: vi.fn().mockReturnValue("/agents/main/memory"),
  };
}

function makeContext(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    allAgents,
    platform: platformConfig,
    userId: "alice",
    userPlatform: "terminal",
    agentsDir: "/agents",
    orchestratorCallbackUrl: "http://localhost:7420",
    workerManager: makeWorkerManager(),
    ...overrides,
  };
}

const encoder = new TextEncoder();

/** Create a mock SSE response yielding a result event */
function makeSseResponse(text: string, sessionId: string): Response {
  const event = JSON.stringify({ type: "result", text, sessionId, stopReason: "end_turn" });
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(`data: ${event}\n\n`));
      c.close();
    },
  });
  return new Response(body as any, { status: 200 });
}

/** Create a mock SSE response yielding a stale_session event */
function makeStaleResponse(): Response {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "stale_session" })}\n\n`));
      c.close();
    },
  });
  return new Response(body as any, { status: 200 });
}

/** Create a mock SSE response yielding an error event */
function makeErrorResponse(message: string): Response {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
      c.close();
    },
  });
  return new Response(body as any, { status: 200 });
}

/** Set up fetch to handle a worker interaction */
function setupWorkerFetch(text: string, sessionId: string, workerSessionId = "ws-test-1") {
  mockFetch.mockImplementation((url: string, opts: RequestInit) => {
    const u = String(url);
    if (u.includes("/sessions") && opts?.method === "POST" && !u.includes("/inject")) {
      return Promise.resolve(
        new Response(JSON.stringify({ workerSessionId }), { status: 200 }),
      );
    }
    if (u.includes(`/sessions/${workerSessionId}/events`)) {
      return Promise.resolve(makeSseResponse(text, sessionId));
    }
    if (u.includes(`/sessions/${workerSessionId}`) && opts?.method === "DELETE") {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

// ── dispatch — HTTP worker dispatch ─────────────────────────────────────────

describe("dispatch — HTTP worker dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls workerManager.ensure and returns result", async () => {
    const workerManager = makeWorkerManager("http://localhost:4001");
    const ctx = makeContext({ workerManager });
    setupWorkerFetch("Hello back!", "sess-abc", "ws-1");

    const result = await dispatch("main", baseMessage, localAgent, null, undefined, ctx);

    expect(workerManager.ensure).toHaveBeenCalledWith("main", localAgent, baseMessage.scope);
    expect(result.result).toBe("Hello back!");
    expect(result.sessionId).toBe("sess-abc");
  });

  it("passes sessionId in POST /sessions body for resume", async () => {
    const ctx = makeContext();
    setupWorkerFetch("Resumed!", "sess-xyz");

    await dispatch("main", baseMessage, localAgent, "sess-existing", undefined, ctx);

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") &&
        opts.method === "POST" &&
        !String(url).includes("/inject"),
    );
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.sessionId).toBe("sess-existing");
  });

  it("strips Agent from tools list in request", async () => {
    const agentWithAgentTool: AgentConfig = {
      ...localAgent,
      tools: ["Bash", "Agent", "Read"],
    };
    const ctx = makeContext();
    setupWorkerFetch("done", "sess-1");

    await dispatch("main", baseMessage, agentWithAgentTool, null, undefined, ctx);

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts.method === "POST",
    );
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.tools).not.toContain("Agent");
    expect(body.tools).toContain("Bash");
  });

  it("includes effort in request when configured", async () => {
    const agentWithEffort: AgentConfig = { ...localAgent, effort: "low" };
    const ctx = makeContext();
    setupWorkerFetch("done", "sess-2");

    await dispatch("main", baseMessage, agentWithEffort, null, undefined, ctx);

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts.method === "POST",
    );
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.effort).toBe("low");
  });

  it("sends orchestratorUrl and callbackToken in request", async () => {
    const ctx = makeContext({ orchestratorCallbackUrl: "http://localhost:7420" });
    setupWorkerFetch("done", "sess-3");

    await dispatch("main", baseMessage, localAgent, null, undefined, ctx);

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts.method === "POST",
    );
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.orchestratorUrl).toBe("http://localhost:7420");
    expect(typeof body.callbackToken).toBe("string");
    expect(body.callbackToken.length).toBeGreaterThan(0);
  });

  it("sends PLATFORM_DISALLOWED_TOOLS as disallowedTools", async () => {
    const ctx = makeContext();
    setupWorkerFetch("done", "sess-4");

    await dispatch("main", baseMessage, localAgent, null, undefined, ctx);

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts.method === "POST",
    );
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.disallowedTools).toEqual(PLATFORM_DISALLOWED_TOOLS);
  });

  it("retries without sessionId on stale_session event", async () => {
    const workerManager = makeWorkerManager();
    const ctx = makeContext({ workerManager });

    let callCount = 0;
    mockFetch.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      if (u.includes("/sessions") && opts?.method === "POST" && !u.includes("/inject")) {
        callCount++;
        return Promise.resolve(
          new Response(JSON.stringify({ workerSessionId: `ws-${callCount}` }), { status: 200 }),
        );
      }
      if (u.includes("/sessions/ws-1/events")) {
        return Promise.resolve(makeStaleResponse());
      }
      if (u.includes("/sessions/ws-2/events")) {
        return Promise.resolve(makeSseResponse("Fresh result", "new-sess"));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    const result = await dispatch("main", baseMessage, localAgent, "stale-sess", undefined, ctx);

    expect(result.result).toBe("Fresh result");
    expect(result.sessionId).toBe("new-sess");
    // Second POST should have no sessionId
    const posts = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts?.method === "POST" && !String(url).includes("/inject"),
    );
    expect(posts).toHaveLength(2);
    const secondBody = JSON.parse(posts[1][1].body as string);
    expect(secondBody.sessionId).toBeUndefined();
    expect(secondBody.forceNewSession).toBe(true);
  });

  it("throws on error event from worker", async () => {
    const ctx = makeContext();

    mockFetch.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      if (u.includes("/sessions") && opts?.method === "POST" && !u.includes("/inject")) {
        return Promise.resolve(
          new Response(JSON.stringify({ workerSessionId: "ws-err" }), { status: 200 }),
        );
      }
      if (u.includes("/sessions/ws-err/events")) {
        return Promise.resolve(makeErrorResponse("Agent SDK failed"));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    await expect(
      dispatch("main", baseMessage, localAgent, null, undefined, ctx),
    ).rejects.toThrow("Agent SDK failed");
  });

  it("throws when POST /sessions returns non-OK", async () => {
    const ctx = makeContext();

    mockFetch.mockResolvedValue(
      new Response("Internal error", { status: 500 }),
    );

    await expect(
      dispatch("main", baseMessage, localAgent, null, undefined, ctx),
    ).rejects.toThrow("Worker returned 500");
  });

  it("calls workerManager.resolveMemoryPath and includes in sdkSettings", async () => {
    const workerManager = makeWorkerManager();
    workerManager.resolveMemoryPath.mockReturnValue("/agents/main/memory");
    const ctx = makeContext({ workerManager });
    setupWorkerFetch("done", "sess-5");

    await dispatch("main", baseMessage, localAgent, null, undefined, ctx);

    expect(workerManager.resolveMemoryPath).toHaveBeenCalledWith("main", localAgent);
    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit]) =>
        String(url).includes("/sessions") && opts.method === "POST",
    );
    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.sdkSettings?.autoMemoryDirectory).toBe("/agents/main/memory");
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
    const agent: AgentConfig = {
      model: "sonnet",
      system: "Custom instructions.",
      system_mode: "append",
    };
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

  it("includes proxy instructions when hasProxy=true and agent has credentials", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "Be helpful.",
      credentials: ["tavily-api-key"],
    };
    const result = buildSystemPrompt(agent, true) as string;
    expect(result).toContain("Credential Proxy");
    expect(result).toContain("tavily-api-key");
  });

  it("excludes proxy instructions when hasProxy=false", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "Be helpful.",
      credentials: ["tavily-api-key"],
    };
    const result = buildSystemPrompt(agent, false) as string;
    expect(result).not.toContain("Credential Proxy");
  });

  it("includes network policy for sandboxed agents", () => {
    const agent: AgentConfig = {
      model: "sonnet",
      system: "You research.",
      sandboxed: true,
    };
    const result = buildSystemPrompt(agent) as string;
    expect(result).toContain("Network Policy");
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

  it("uses provided memoryDir directly", () => {
    const agent: AgentConfig = { model: "sonnet", system: "test" };
    const settings = buildSdkSettings(agent, "main", "/data/agents/main/memory");

    expect(settings.autoMemoryDirectory).toBe("/data/agents/main/memory");
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

  it("includes WebSearch", () => {
    expect(PLATFORM_DISALLOWED_TOOLS).toContain("WebSearch");
  });

  it("includes AskUserQuestion", () => {
    expect(PLATFORM_DISALLOWED_TOOLS).toContain("AskUserQuestion");
  });
});
