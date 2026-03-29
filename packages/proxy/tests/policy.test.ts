import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/shared/policy.js";
import type { Policy } from "../src/shared/types.js";

const githubRules: Policy = {
  default: "deny",
  rules: [
    { host: "api.github.com", method: "GET", action: "allow" },
    { host: "api.github.com", path: "/repos/*/pulls", method: "POST", action: "allow" },
    { host: "api.github.com", action: "deny" },
  ],
};

describe("evaluatePolicy", () => {
  it("allows exact host match", () => {
    const policy: Policy = {
      default: "deny",
      rules: [{ host: "api.anthropic.com", action: "allow" }],
    };
    expect(evaluatePolicy(policy, { host: "api.anthropic.com" })).toBe("allow");
  });

  it("denies unmatched host with default deny", () => {
    const policy: Policy = {
      default: "deny",
      rules: [{ host: "api.anthropic.com", action: "allow" }],
    };
    expect(evaluatePolicy(policy, { host: "evil.com" })).toBe("deny");
  });

  it("allows unmatched host with default allow", () => {
    const policy: Policy = {
      default: "allow",
      rules: [{ host: "evil.com", action: "deny" }],
    };
    expect(evaluatePolicy(policy, { host: "safe.com" })).toBe("allow");
  });

  it("matches wildcard host *.example.com", () => {
    const policy: Policy = {
      default: "deny",
      rules: [{ host: "*.googleapis.com", action: "allow" }],
    };
    expect(evaluatePolicy(policy, { host: "storage.googleapis.com" })).toBe("allow");
    expect(evaluatePolicy(policy, { host: "googleapis.com" })).toBe("deny");
  });

  it("matches catch-all wildcard *", () => {
    const policy: Policy = {
      default: "allow",
      rules: [{ host: "*", action: "deny" }],
    };
    expect(evaluatePolicy(policy, { host: "anything.com" })).toBe("deny");
  });

  it("filters by method", () => {
    expect(evaluatePolicy(githubRules, { host: "api.github.com", method: "GET" })).toBe("allow");
    expect(evaluatePolicy(githubRules, { host: "api.github.com", method: "DELETE" })).toBe("deny");
  });

  it("filters by path glob", () => {
    expect(
      evaluatePolicy(githubRules, {
        host: "api.github.com",
        path: "/repos/myorg/pulls",
        method: "POST",
      })
    ).toBe("allow");

    expect(
      evaluatePolicy(githubRules, {
        host: "api.github.com",
        path: "/orgs/myorg",
        method: "POST",
      })
    ).toBe("deny");
  });

  it("matches port for SSH rules", () => {
    const policy: Policy = {
      default: "deny",
      rules: [
        { host: "github.com", port: 22, action: "allow" },
        { host: "github.com", port: 443, action: "deny" },
      ],
    };
    expect(evaluatePolicy(policy, { host: "github.com", port: 22 })).toBe("allow");
    expect(evaluatePolicy(policy, { host: "github.com", port: 443 })).toBe("deny");
  });

  it("first match wins — order matters", () => {
    const policy: Policy = {
      default: "deny",
      rules: [
        { host: "api.github.com", action: "allow" },
        { host: "api.github.com", action: "deny" },
      ],
    };
    expect(evaluatePolicy(policy, { host: "api.github.com" })).toBe("allow");
  });

  it("rule with only host matches all methods and paths", () => {
    const policy: Policy = {
      default: "deny",
      rules: [{ host: "example.com", action: "allow" }],
    };
    expect(
      evaluatePolicy(policy, { host: "example.com", method: "POST", path: "/anything" })
    ).toBe("allow");
  });

  it("method filtering is case-insensitive", () => {
    const policy: Policy = {
      default: "deny",
      rules: [{ host: "example.com", method: "GET", action: "allow" }],
    };
    expect(evaluatePolicy(policy, { host: "example.com", method: "get" })).toBe("allow");
    expect(evaluatePolicy(policy, { host: "example.com", method: "Get" })).toBe("allow");
  });
});
