import { describe, it, expect } from "vitest";
import {
  resolveUser,
  checkAccess,
  buildPermissionHook,
  matchesToolRule,
} from "../src/rbac.js";
import type { PlatformConfig } from "../src/types.js";

const config: PlatformConfig = {
  channels: {
    terminal: { enabled: true, agent: "main" },
  },
  rbac: {
    roles: {
      owner: {
        permissions: ["agent:*"],
        // Owner has no deny/allow — all tools allowed by default
      },
      operator: {
        permissions: ["agent:main"],
        deny: ["tool:Bash"],
        allow: ["tool:Bash:git *", "tool:Bash:ls *", "tool:Bash:npm *"],
      },
      restricted: {
        permissions: ["agent:main"],
        deny: ["tool:*"],
        allow: ["tool:Read", "tool:Glob", "tool:Grep"],
      },
      viewer: {
        permissions: ["agent:main"],
        deny: ["tool:*"],
        // No allow — can't use any tools
      },
    },
    users: {
      alice: {
        roles: ["owner"],
        identities: { discord: "alice-discord-id", terminal: "alice" },
      },
      bob: {
        roles: ["operator"],
        identities: { discord: "bob-discord-id", terminal: "bob" },
      },
      carol: {
        roles: ["restricted"],
        identities: { discord: "carol-discord-id" },
      },
      dave: {
        roles: ["viewer"],
        identities: { terminal: "dave" },
      },
    },
  },
};

// ── resolveUser ──────────────────────────────────────────────────────────────

describe("resolveUser", () => {
  it("resolves a known discord user with deny/allow", () => {
    const user = resolveUser("alice-discord-id", "discord", config);
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
    expect(user!.roles).toEqual(["owner"]);
    expect(user!.permissions).toContain("agent:*");
    expect(user!.deny).toEqual([]);
    expect(user!.allow).toEqual([]);
  });

  it("resolves operator with deny and allow lists", () => {
    const user = resolveUser("bob", "terminal", config);
    expect(user).not.toBeNull();
    expect(user!.deny).toEqual(["tool:Bash"]);
    expect(user!.allow).toEqual(["tool:Bash:git *", "tool:Bash:ls *", "tool:Bash:npm *"]);
  });

  it("returns null for unknown user", () => {
    expect(resolveUser("unknown-id", "discord", config)).toBeNull();
  });

  it("returns null for known user on wrong platform", () => {
    expect(resolveUser("carol-discord-id", "terminal", config)).toBeNull();
  });
});

// ── checkAccess ──────────────────────────────────────────────────────────────

describe("checkAccess", () => {
  it("grants owner access to any agent (wildcard)", () => {
    expect(checkAccess("alice-discord-id", "discord", "main", config)).toBe(true);
    expect(checkAccess("alice-discord-id", "discord", "researcher", config)).toBe(true);
  });

  it("grants operator access to permitted agent", () => {
    expect(checkAccess("bob-discord-id", "discord", "main", config)).toBe(true);
  });

  it("denies operator access to non-permitted agent", () => {
    expect(checkAccess("bob-discord-id", "discord", "researcher", config)).toBe(false);
  });

  it("denies access to unknown user", () => {
    expect(checkAccess("unknown-id", "discord", "main", config)).toBe(false);
  });
});

// ── matchesToolRule ──────────────────────────────────────────────────────────

describe("matchesToolRule", () => {
  it("tool:* matches any tool", () => {
    expect(matchesToolRule("tool:*", "Bash", {})).toBe(true);
    expect(matchesToolRule("tool:*", "Read", {})).toBe(true);
  });

  it("tool:Bash matches Bash with any input", () => {
    expect(matchesToolRule("tool:Bash", "Bash", { command: "anything" })).toBe(true);
  });

  it("tool:Bash does not match Read", () => {
    expect(matchesToolRule("tool:Bash", "Read", {})).toBe(false);
  });

  it("tool:Bash:git * matches git commands", () => {
    expect(matchesToolRule("tool:Bash:git *", "Bash", { command: "git status" })).toBe(true);
    expect(matchesToolRule("tool:Bash:git *", "Bash", { command: "git log --oneline" })).toBe(true);
  });

  it("tool:Bash:git * does not match non-git commands", () => {
    expect(matchesToolRule("tool:Bash:git *", "Bash", { command: "rm -rf /" })).toBe(false);
  });

  it("tool:Bash:rm -rf * matches destructive rm", () => {
    expect(matchesToolRule("tool:Bash:rm -rf *", "Bash", { command: "rm -rf /" })).toBe(true);
    expect(matchesToolRule("tool:Bash:rm -rf *", "Bash", { command: "rm -rf /home" })).toBe(true);
  });

  it("ignores non-tool rules", () => {
    expect(matchesToolRule("agent:main", "Bash", {})).toBe(false);
  });

  it("uses input.content as fallback when input.command is absent", () => {
    expect(matchesToolRule("tool:Edit:*.ts", "Edit", { content: "foo.ts" })).toBe(true);
  });
});

// ── buildPermissionHook ──────────────────────────────────────────────────────

describe("buildPermissionHook", () => {
  // ── Owner: no deny rules, everything allowed ──

  it("owner with no deny rules — all tools allowed", async () => {
    const hook = buildPermissionHook("alice-discord-id", "discord", config);

    expect(await hook("Bash", { command: "rm -rf /" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Read", { path: "/etc/passwd" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Write", {})).toMatchObject({ behavior: "allow" });
    expect(await hook("AnyTool", {})).toMatchObject({ behavior: "allow" });
  });

  // ── Operator: Bash denied, with git/ls/npm exceptions ──

  it("operator denied Bash by default", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    const result = await hook("Bash", { command: "rm -rf /" });
    expect(result.behavior).toBe("deny");
  });

  it("operator allowed git commands (exception to Bash deny)", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Bash", { command: "git status" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Bash", { command: "git log --oneline" })).toMatchObject({ behavior: "allow" });
  });

  it("operator allowed ls commands (exception to Bash deny)", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Bash", { command: "ls -la" })).toMatchObject({ behavior: "allow" });
  });

  it("operator allowed npm commands (exception to Bash deny)", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Bash", { command: "npm install" })).toMatchObject({ behavior: "allow" });
  });

  it("operator non-Bash tools are allowed (no deny rule for them)", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Read", { path: "/tmp/file" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Write", { path: "/tmp/file" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Glob", { pattern: "*.ts" })).toMatchObject({ behavior: "allow" });
  });

  // ── Restricted: all tools denied except Read/Glob/Grep ──

  it("restricted user denied all tools by default", async () => {
    const hook = buildPermissionHook("carol-discord-id", "discord", config);

    expect((await hook("Bash", { command: "ls" })).behavior).toBe("deny");
    expect((await hook("Write", {})).behavior).toBe("deny");
    expect((await hook("Edit", {})).behavior).toBe("deny");
  });

  it("restricted user allowed Read/Glob/Grep (exceptions)", async () => {
    const hook = buildPermissionHook("carol-discord-id", "discord", config);

    expect(await hook("Read", { path: "/tmp" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Glob", { pattern: "*.ts" })).toMatchObject({ behavior: "allow" });
    expect(await hook("Grep", { pattern: "foo" })).toMatchObject({ behavior: "allow" });
  });

  // ── Viewer: all tools denied, no exceptions ──

  it("viewer denied all tools, no exceptions", async () => {
    const hook = buildPermissionHook("dave", "terminal", config);

    expect((await hook("Bash", { command: "ls" })).behavior).toBe("deny");
    expect((await hook("Read", {})).behavior).toBe("deny");
    expect((await hook("Write", {})).behavior).toBe("deny");
  });

  // ── Unknown user ──

  it("unknown user denied everything", async () => {
    const hook = buildPermissionHook("unknown-id", "discord", config);

    expect((await hook("Read", {})).behavior).toBe("deny");
    expect((await hook("Bash", {})).behavior).toBe("deny");
  });

  // ── MCP-style tool names ──

  it("deny tool:* blocks MCP-style tool names too", async () => {
    const hook = buildPermissionHook("dave", "terminal", config);

    expect((await hook("mcp__some_server__some_tool", {})).behavior).toBe("deny");
  });

  it("no deny rules allows MCP-style tool names", async () => {
    const hook = buildPermissionHook("alice-discord-id", "discord", config);

    expect(await hook("mcp__some_server__some_tool", {})).toMatchObject({ behavior: "allow" });
  });

  it("core platform tools (ask_agent) always allowed even with deny:*", async () => {
    const hook = buildPermissionHook("dave", "terminal", config);

    expect((await hook("mcp__orchestrator__ask_agent", {})).behavior).toBe("allow");
  });
});

// ── Two-layer: user RBAC + agent permissions ────────────────────────────────

describe("buildPermissionHook — agent-level permissions (layer 2)", () => {
  it("agent deny rule blocks even when user allows", async () => {
    const agentRules = ["deny:Write", "allow:*"];
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform");

    // Owner (alice) has no user-level deny, but agent denies Write
    expect((await hook("Write", { file_path: "/tmp/file.txt" })).behavior).toBe("deny");
    // Other tools still allowed
    expect((await hook("Read", { file_path: "/tmp/file.txt" })).behavior).toBe("allow");
  });

  it("user deny takes precedence over agent allow", async () => {
    // Dave (viewer role) has deny:* at user level
    const agentRules = ["allow:*"];
    const hook = buildPermissionHook("dave", "terminal", config, agentRules, "/tmp", "/tmp/.platform");

    // User-level denies all, agent allows all — user wins
    expect((await hook("Read", {})).behavior).toBe("deny");
  });

  it("no agent rules (undefined) = no agent restrictions", async () => {
    const hook = buildPermissionHook("alice-discord-id", "discord", config, undefined, "/tmp");

    expect((await hook("Bash", { command: "rm -rf /" })).behavior).toBe("allow");
  });

  it("empty agent rules = ask (implicit HITL), denied without callback", async () => {
    const hook = buildPermissionHook("alice-discord-id", "discord", config, [], "/tmp", "/tmp/.platform");

    // Owner at user level, but empty agent rules = implicit ask → deny (no callback)
    expect((await hook("Read", { file_path: "/tmp" })).behavior).toBe("deny");
  });

  it("agent / prefix rules protect platform root", async () => {
    const { resolve, join } = await import("node:path");
    const platformRoot = resolve("/tmp/test-platform");
    const agentRules = [
      "deny:Write(/config/**)",
      "deny:Edit(/config/**)",
      "allow:*",
    ];
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", platformRoot);

    expect(
      (await hook("Write", { file_path: join(platformRoot, "config", "a.yaml") })).behavior,
    ).toBe("deny");
    expect(
      (await hook("Read", { file_path: join(platformRoot, "config", "a.yaml") })).behavior,
    ).toBe("allow");
    expect(
      (await hook("Write", { file_path: resolve("/safe/file.txt") })).behavior,
    ).toBe("allow");
  });

  it("agent Bash command rules work", async () => {
    const agentRules = [
      "allow:Bash(git *)",
      "deny:Bash",
      "allow:*",
    ];
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform");

    expect((await hook("Bash", { command: "git status" })).behavior).toBe("allow");
    expect((await hook("Bash", { command: "rm -rf /" })).behavior).toBe("deny");
  });

  it("deny message distinguishes user vs agent policy", async () => {
    // User-level deny
    const userHook = buildPermissionHook("dave", "terminal", config);
    const userResult = await userHook("Bash", { command: "ls" });
    expect(userResult.behavior).toBe("deny");
    expect((userResult as { message: string }).message).toContain("user policy");

    // Agent-level deny
    const agentHook = buildPermissionHook("alice-discord-id", "discord", config, ["deny:Bash", "allow:*"], "/tmp", "/tmp/.platform");
    const agentResult = await agentHook("Bash", { command: "ls" });
    expect(agentResult.behavior).toBe("deny");
    expect((agentResult as { message: string }).message).toContain("agent policy");
  });
});

// ── HITL ask permission ─────────────────────────────────────────────────────

describe("buildPermissionHook — HITL ask permissions", () => {
  it("ask rule with callback approved → allow", async () => {
    const agentRules = ["ask:Bash", "allow:*"];
    const askApproval = async () => true;
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    expect((await hook("Bash", { command: "ls" })).behavior).toBe("allow");
  });

  it("ask rule with callback denied → deny", async () => {
    const agentRules = ["ask:Bash", "allow:*"];
    const askApproval = async () => false;
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    const result = await hook("Bash", { command: "ls" });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("HITL");
  });

  it("ask rule without callback → deny", async () => {
    const agentRules = ["ask:Bash", "allow:*"];
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform");

    const result = await hook("Bash", { command: "ls" });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("no HITL callback");
  });

  it("implicit ask (no matching rule) with callback approved → allow", async () => {
    const agentRules = ["allow:Read"];
    const askApproval = async () => true;
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    // Read matches → allow directly
    expect((await hook("Read", { file_path: "/tmp" })).behavior).toBe("allow");
    // Write doesn't match any rule → implicit ask → callback approves
    expect((await hook("Write", { file_path: "/tmp/file.txt" })).behavior).toBe("allow");
  });

  it("implicit ask (no matching rule) with callback denied → deny", async () => {
    const agentRules = ["allow:Read"];
    const askApproval = async () => false;
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    expect((await hook("Write", { file_path: "/tmp/file.txt" })).behavior).toBe("deny");
  });

  it("callback receives correct tool and input", async () => {
    const agentRules = ["ask:*"];
    let capturedTool = "";
    let capturedInput: Record<string, unknown> = {};
    const askApproval = async (tool: string, input: Record<string, unknown>) => {
      capturedTool = tool;
      capturedInput = input;
      return true;
    };
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    await hook("Bash", { command: "git status" });
    expect(capturedTool).toBe("Bash");
    expect(capturedInput).toEqual({ command: "git status" });
  });

  it("explicit allow bypasses ask callback", async () => {
    const agentRules = ["allow:Read", "ask:*"];
    let callbackCalled = false;
    const askApproval = async () => {
      callbackCalled = true;
      return true;
    };
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    await hook("Read", { file_path: "/tmp" });
    expect(callbackCalled).toBe(false);
  });

  it("explicit deny bypasses ask callback", async () => {
    const agentRules = ["deny:Bash", "ask:*"];
    let callbackCalled = false;
    const askApproval = async () => {
      callbackCalled = true;
      return true;
    };
    const hook = buildPermissionHook("alice-discord-id", "discord", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    const result = await hook("Bash", { command: "ls" });
    expect(result.behavior).toBe("deny");
    expect(callbackCalled).toBe(false);
  });

  it("user-level deny still takes precedence over agent ask", async () => {
    // Dave (viewer) has deny:* at user level
    const agentRules = ["ask:*"];
    const askApproval = async () => true;
    const hook = buildPermissionHook("dave", "terminal", config, agentRules, "/tmp", "/tmp/.platform", askApproval);

    // User-level deny wins before agent rules even run
    expect((await hook("Read", {})).behavior).toBe("deny");
  });
});
