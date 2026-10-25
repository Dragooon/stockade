import { describe, it, expect } from "vitest";
import { buildPreToolUseHook } from "../src/rbac.js";
import { createCallbackSession, getCallbackSession, updateCallbackSession, deleteCallbackSession } from "../src/api/sessions.js";
import type { PlatformConfig } from "../src/types.js";

// alice can do anything; bob's role denies Bash except git. A turn a peer message starts
// on bob's behalf must be checked against bob's permissions, not the session's last person.
const config: PlatformConfig = {
  channels: { terminal: { enabled: true, agent: "main" } },
  rbac: {
    roles: {
      owner: { permissions: ["agent:*"] },
      operator: { permissions: ["agent:main"], deny: ["tool:Bash"], allow: ["tool:Bash:git *"] },
    },
    users: {
      alice: { roles: ["owner"], identities: { discord: "alice-id" } },
      bob: { roles: ["operator"], identities: { discord: "bob-id" } },
    },
  },
} as PlatformConfig;

/** What /cb/:token/pretooluse decides for a tool call in this session's current turn. */
async function decide(token: string, command: string) {
  const ctx = getCallbackSession(token)!;
  const hook = buildPreToolUseHook(ctx.userId, ctx.userPlatform, config, undefined, "/w", "/p", undefined, "main");
  const result = await hook({ tool_name: "Bash", tool_input: { command } });
  return result.hookSpecificOutput.permissionDecision;
}

describe("RBAC in a peer-started turn uses the acting person", () => {
  it("denies bob what alice could do in the same session, and carries the hop count", async () => {
    const token = "peer-rbac-test";
    createCallbackSession(token, {
      callbackToken: token, agentId: "main", scope: "discord:g:c", userId: "alice-id", userPlatform: "discord",
      agentConfig: {} as never, agentCwd: "/w", platformRoot: "/p", platformConfig: config,
      allAgents: {} as never, agentsDir: "/a",
    });
    try {
      expect(await decide(token, "rm -rf build")).not.toBe("deny");

      // A peer message on bob's behalf starts the next turn (identity applied at turn start).
      updateCallbackSession(token, { userId: "bob-id", userPlatform: "discord", hops: 1 });
      expect(getCallbackSession(token)!.hops).toBe(1);
      expect(await decide(token, "rm -rf build")).toBe("deny");
      expect(await decide(token, "git status")).not.toBe("deny");
    } finally {
      deleteCallbackSession(token);
    }
  });
});
