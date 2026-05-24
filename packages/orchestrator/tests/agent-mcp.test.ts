import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallbackSession } from "../src/api/sessions.js";
import type { AgentConfig, AgentsConfig, PlatformConfig } from "../src/types.js";

vi.mock("../src/rbac.js", () => ({
  checkAccess: vi.fn().mockReturnValue(true),
  buildPermissionHook: vi.fn(),
  resolveEffectivePermissions: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/gatekeeper.js", () => ({
  resolveEffectivePermissions: vi.fn().mockReturnValue([]),
}));

const { handleAgentStart } = await import("../src/agent-mcp.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const searchAgent: AgentConfig = {
  model: "claude-haiku-4-5-20251001",
  system: "You search the web.",
  sandboxed: true,
};

const allAgents: AgentsConfig = {
  agents: {
    main: { model: "claude-opus-4-7", system: "You are Madge." },
    search: searchAgent,
  },
};

const platformConfig = {} as PlatformConfig;

function makeParentCtx(token = "parent-token-abc"): CallbackSession {
  return {
    callbackToken: token,
    agentId: "main",
    scope: "discord:server:channel",
    userId: "shitiz",
    userPlatform: "discord",
    agentConfig: allAgents.agents.main,
    agentCwd: "/workspace",
    platformRoot: "/platform",
    platformConfig,
    allAgents,
    agentsDir: "/agents",
  };
}

function makeBridge() {
  const calls: Array<{ scope: string; task: string }> = [];
  const bridge = {
    sendAndWait: vi.fn(async (scope: string, task: string) => {
      calls.push({ scope, task });
      return { text: `result for ${scope}` };
    }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    bus: {},
  };
  return { bridge, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleAgentStart — scope isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives each ephemeral sub-agent a unique scope", async () => {
    const parentCtx = makeParentCtx();
    const { bridge, calls } = makeBridge();

    // Fire three parallel search agents — no session key, non-self-spawn
    await Promise.all([
      handleAgentStart(
        { agentId: "search", task: "research crafting", background: false },
        parentCtx, {} as any, {} as any, bridge as any,
      ),
      handleAgentStart(
        { agentId: "search", task: "research meta", background: false },
        parentCtx, {} as any, {} as any, bridge as any,
      ),
      handleAgentStart(
        { agentId: "search", task: "research trade", background: false },
        parentCtx, {} as any, {} as any, bridge as any,
      ),
    ]);

    const scopes = calls.map((c) => c.scope);
    expect(scopes).toHaveLength(3);

    // Every scope must be unique — the old bug made them all identical
    const unique = new Set(scopes);
    expect(unique.size).toBe(3);

    // Each scope must follow the ephemeral pattern (subagent:<id>:<runId>)
    for (const scope of scopes) {
      expect(scope).toMatch(/^subagent:search:[0-9a-f-]{36}$/);
    }
  });

  it("the old behaviour (all same scope) would have failed the uniqueness check", () => {
    // Regression guard: verify what the broken scopes looked like
    const brokenScopes = [
      "subagent:search:parent-token-abc",
      "subagent:search:parent-token-abc",
      "subagent:search:parent-token-abc",
    ];
    expect(new Set(brokenScopes).size).toBe(1); // all identical — that was the bug
  });

  it("session-keyed agents still share the same stable scope across calls", async () => {
    const parentCtx = makeParentCtx();
    const { bridge, calls } = makeBridge();

    await handleAgentStart(
      { agentId: "search", task: "first call", session: "my-session" },
      parentCtx, {} as any, {} as any, bridge as any,
    );
    await handleAgentStart(
      { agentId: "search", task: "second call", session: "my-session" },
      parentCtx, {} as any, {} as any, bridge as any,
    );

    const scopes = calls.map((c) => c.scope);
    expect(scopes[0]).toBe("subagent:search:session:my-session");
    expect(scopes[1]).toBe("subagent:search:session:my-session");
  });

  it("self-spawns get unique scopes based on runId", async () => {
    const parentCtx = makeParentCtx();
    const { bridge, calls } = makeBridge();

    await Promise.all([
      handleAgentStart({ task: "parallel reasoning A" }, parentCtx, {} as any, {} as any, bridge as any),
      handleAgentStart({ task: "parallel reasoning B" }, parentCtx, {} as any, {} as any, bridge as any),
    ]);

    const scopes = calls.map((c) => c.scope);
    expect(new Set(scopes).size).toBe(2);
    for (const scope of scopes) {
      expect(scope).toMatch(/^self-spawn:main:[0-9a-f-]{36}$/);
    }
  });
});
