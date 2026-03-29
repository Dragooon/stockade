import { describe, it, expect } from "vitest";
import { resolveAgent } from "../src/router.js";
import type { PlatformConfig } from "../src/types.js";

const config: PlatformConfig = {
  channels: {
    terminal: { enabled: true, agent: "main" },
    discord: {
      enabled: true,
      token: "test-token",
      bindings: [
        { server: "server-1", agent: "main", channels: "*" },
        {
          server: "server-2",
          agent: "researcher",
          channels: ["channel-a", "channel-b"],
        },
        { server: "server-3", agent: "helper", channels: "channel-x" },
      ],
    },
  },
  rbac: { roles: {}, users: {} },
};

describe("resolveAgent", () => {
  it("routes terminal scope to terminal agent", () => {
    expect(resolveAgent("terminal:uuid:alice", config)).toBe("main");
  });

  it("routes discord wildcard binding", () => {
    expect(
      resolveAgent("discord:server-1:any-channel:user-1", config)
    ).toBe("main");
  });

  it("routes discord exact channel match (array)", () => {
    expect(
      resolveAgent("discord:server-2:channel-a:user-1", config)
    ).toBe("researcher");
    expect(
      resolveAgent("discord:server-2:channel-b:user-1", config)
    ).toBe("researcher");
  });

  it("routes discord exact channel match (string)", () => {
    expect(
      resolveAgent("discord:server-3:channel-x:user-1", config)
    ).toBe("helper");
  });

  it("throws for unmatched discord channel", () => {
    expect(() =>
      resolveAgent("discord:server-2:channel-z:user-1", config)
    ).toThrow("No binding found");
  });

  it("routes 5-segment discord thread scope via parent channel", () => {
    // Thread scope: discord:<server>:<parentChannel>:<threadId>:<userId>
    // Router uses parts[2] (parent channel) for binding lookup
    expect(
      resolveAgent("discord:server-2:channel-a:thread-99:user-1", config)
    ).toBe("researcher");
  });

  it("throws for unknown server", () => {
    expect(() =>
      resolveAgent("discord:unknown-server:ch:user", config)
    ).toThrow("No binding found");
  });

  it("throws for unknown platform", () => {
    expect(() => resolveAgent("slack:123:456", config)).toThrow(
      "Unknown platform"
    );
  });

  it("throws when terminal not configured", () => {
    const noTerminal: PlatformConfig = {
      channels: {},
      rbac: { roles: {}, users: {} },
    };
    expect(() => resolveAgent("terminal:uuid:user", noTerminal)).toThrow(
      "No terminal channel configured"
    );
  });

  it("throws when discord not configured", () => {
    const noDiscord: PlatformConfig = {
      channels: { terminal: { enabled: true, agent: "main" } },
      rbac: { roles: {}, users: {} },
    };
    expect(() =>
      resolveAgent("discord:server:ch:user", noDiscord)
    ).toThrow("No discord channel configured");
  });
});
