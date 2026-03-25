import { describe, it, expect } from "vitest";
import {
  resolveUser,
  checkAccess,
  buildPermissionHook,
} from "../src/rbac.js";
import type { PlatformConfig } from "../src/types.js";

const config: PlatformConfig = {
  channels: {
    terminal: { enabled: true, agent: "main" },
  },
  rbac: {
    roles: {
      owner: {
        permissions: ["agent:*", "tool:*"],
      },
      user: {
        permissions: ["agent:main", "tool:Read", "tool:Bash:git*"],
      },
      viewer: {
        permissions: ["agent:main"],
      },
    },
    users: {
      alice: {
        roles: ["owner"],
        identities: { discord: "alice-discord-id", terminal: "alice" },
      },
      bob: {
        roles: ["user"],
        identities: { discord: "bob-discord-id", terminal: "bob" },
      },
      carol: {
        roles: ["viewer"],
        identities: { discord: "carol-discord-id" },
      },
    },
  },
};

describe("resolveUser", () => {
  it("resolves a known discord user", () => {
    const user = resolveUser("alice-discord-id", "discord", config);
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
    expect(user!.roles).toEqual(["owner"]);
    expect(user!.permissions).toContain("agent:*");
    expect(user!.permissions).toContain("tool:*");
  });

  it("resolves a known terminal user", () => {
    const user = resolveUser("bob", "terminal", config);
    expect(user).not.toBeNull();
    expect(user!.username).toBe("bob");
    expect(user!.roles).toEqual(["user"]);
  });

  it("returns null for unknown user", () => {
    const user = resolveUser("unknown-id", "discord", config);
    expect(user).toBeNull();
  });

  it("returns null for known user on wrong platform", () => {
    // carol has no terminal identity
    const user = resolveUser("carol-discord-id", "terminal", config);
    expect(user).toBeNull();
  });
});

describe("checkAccess", () => {
  it("grants owner access to any agent (wildcard)", () => {
    expect(
      checkAccess("alice-discord-id", "discord", "main", config)
    ).toBe(true);
    expect(
      checkAccess("alice-discord-id", "discord", "researcher", config)
    ).toBe(true);
    expect(
      checkAccess("alice-discord-id", "discord", "anything", config)
    ).toBe(true);
  });

  it("grants user access to permitted agent", () => {
    expect(
      checkAccess("bob-discord-id", "discord", "main", config)
    ).toBe(true);
  });

  it("denies user access to non-permitted agent", () => {
    expect(
      checkAccess("bob-discord-id", "discord", "researcher", config)
    ).toBe(false);
  });

  it("denies access to unknown user", () => {
    expect(
      checkAccess("unknown-id", "discord", "main", config)
    ).toBe(false);
  });
});

describe("buildPermissionHook", () => {
  it("owner with tool:* allows everything", async () => {
    const hook = buildPermissionHook("alice-discord-id", "discord", config);

    expect(await hook("Bash", { command: "rm -rf /" })).toMatchObject({
      behavior: "allow",
    });
    expect(await hook("Read", { path: "/etc/passwd" })).toMatchObject({
      behavior: "allow",
    });
    expect(await hook("AnyTool", {})).toMatchObject({ behavior: "allow" });
  });

  it("user with tool:Read allows Read", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Read", { path: "/tmp/file" })).toMatchObject({
      behavior: "allow",
    });
  });

  it("user with tool:Bash:git* allows git commands", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    expect(await hook("Bash", { command: "git status" })).toMatchObject({
      behavior: "allow",
    });
    expect(await hook("Bash", { command: "git log --oneline" })).toMatchObject({
      behavior: "allow",
    });
  });

  it("user with tool:Bash:git* denies non-git Bash commands", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    const result = await hook("Bash", { command: "rm -rf /" });
    expect(result.behavior).toBe("deny");
    expect((result as any).message).toContain("Bash");
  });

  it("user without tool permission is denied", async () => {
    const hook = buildPermissionHook("bob-discord-id", "discord", config);

    const result = await hook("Write", { path: "/tmp/file", content: "x" });
    expect(result.behavior).toBe("deny");
  });

  it("unknown user is denied everything", async () => {
    const hook = buildPermissionHook("unknown-id", "discord", config);

    const result = await hook("Read", {});
    expect(result.behavior).toBe("deny");
  });

  it("viewer with no tool permissions is denied all tools", async () => {
    const hook = buildPermissionHook(
      "carol-discord-id",
      "discord",
      config
    );

    const result = await hook("Bash", { command: "ls" });
    expect(result.behavior).toBe("deny");
  });
});
