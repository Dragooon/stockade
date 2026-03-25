import { describe, it, expect } from "vitest";
import {
  buildScope,
  parseScope,
  discordScope,
  discordThreadScope,
  terminalScope,
} from "../src/channels/scope.js";

describe("buildScope", () => {
  it("joins parts with colons", () => {
    expect(buildScope(["discord", "111", "222", "333"])).toBe(
      "discord:111:222:333"
    );
  });

  it("handles two parts", () => {
    expect(buildScope(["terminal", "user"])).toBe("terminal:user");
  });

  it("throws on empty parts array", () => {
    expect(() => buildScope([])).toThrow("at least one part");
  });

  it("throws on empty string segment", () => {
    expect(() => buildScope(["discord", "", "222"])).toThrow(
      "must not be empty"
    );
  });
});

describe("parseScope", () => {
  it("parses platform and remaining parts", () => {
    const result = parseScope("discord:111:222:333");
    expect(result.platform).toBe("discord");
    expect(result.parts).toEqual(["111", "222", "333"]);
  });

  it("parses terminal scope", () => {
    const result = parseScope("terminal:uuid:alice");
    expect(result.platform).toBe("terminal");
    expect(result.parts).toEqual(["uuid", "alice"]);
  });

  it("throws on single segment (no colon)", () => {
    expect(() => parseScope("noplatform")).toThrow("Invalid scope");
  });
});

describe("roundtrip", () => {
  it("build then parse gives original parts", () => {
    const parts = ["discord", "server-1", "channel-a", "user-42"];
    const scope = buildScope(parts);
    const parsed = parseScope(scope);
    expect(parsed.platform).toBe("discord");
    expect([parsed.platform, ...parsed.parts]).toEqual(parts);
  });
});

describe("discordScope", () => {
  it("builds a discord channel scope", () => {
    expect(discordScope("s1", "c1", "u1")).toBe("discord:s1:c1:u1");
  });
});

describe("discordThreadScope", () => {
  it("builds a discord thread scope", () => {
    expect(discordThreadScope("s1", "c1", "t1", "u1")).toBe(
      "discord:s1:c1:t1:u1"
    );
  });
});

describe("terminalScope", () => {
  it("builds a terminal scope", () => {
    expect(terminalScope("sess-123", "alice")).toBe(
      "terminal:sess-123:alice"
    );
  });
});
