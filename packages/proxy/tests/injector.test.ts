import { describe, it, expect } from "vitest";
import { stripHeaders, injectCredential, matchRoute } from "../src/http/injector.js";
import type { HttpRoute } from "../src/shared/types.js";

describe("stripHeaders", () => {
  it("removes listed headers case-insensitively", () => {
    const headers = {
      Authorization: "Bearer secret",
      "X-Api-Key": "key123",
      "Content-Type": "application/json",
    };
    const result = stripHeaders(headers, ["authorization", "x-api-key"]);
    expect(result).toEqual({ "Content-Type": "application/json" });
  });

  it("preserves all headers when strip list is empty", () => {
    const headers = { Authorization: "Bearer secret", Host: "example.com" };
    const result = stripHeaders(headers, []);
    expect(result).toEqual(headers);
  });

  it("handles no matching headers gracefully", () => {
    const headers = { "Content-Type": "text/html" };
    const result = stripHeaders(headers, ["authorization"]);
    expect(result).toEqual({ "Content-Type": "text/html" });
  });
});

describe("injectCredential", () => {
  const route: HttpRoute = {
    host: "api.github.com",
    credential: "AgentVault/GitHub/token",
    inject: { header: "authorization", format: "token {value}" },
  };

  it("injects credential with format template", () => {
    const result = injectCredential({}, route, "ghp_abc123");
    expect(result.authorization).toBe("token ghp_abc123");
  });

  it("injects raw value when no format specified", () => {
    const rawRoute: HttpRoute = {
      host: "api.anthropic.com",
      credential: "AgentVault/Anthropic/api-key",
      inject: { header: "x-api-key" },
    };
    const result = injectCredential({}, rawRoute, "sk-ant-abc123");
    expect(result["x-api-key"]).toBe("sk-ant-abc123");
  });

  it("preserves existing headers", () => {
    const result = injectCredential(
      { "Content-Type": "application/json" },
      route,
      "ghp_abc123"
    );
    expect(result["Content-Type"]).toBe("application/json");
    expect(result.authorization).toBe("token ghp_abc123");
  });
});

describe("matchRoute", () => {
  const routes: HttpRoute[] = [
    {
      host: "api.github.com",
      credential: "AgentVault/GitHub/token",
      inject: { header: "authorization", format: "token {value}" },
    },
    {
      host: "*.googleapis.com",
      credential: "AgentVault/Google/oauth-token",
      inject: { header: "authorization", format: "Bearer {value}" },
    },
    {
      host: "api.anthropic.com",
      credential: "AgentVault/Anthropic/api-key",
      inject: { header: "x-api-key" },
    },
  ];

  it("matches exact host", () => {
    const route = matchRoute(routes, "api.github.com");
    expect(route?.credential).toBe("AgentVault/GitHub/token");
  });

  it("matches wildcard host", () => {
    const route = matchRoute(routes, "storage.googleapis.com");
    expect(route?.credential).toBe("AgentVault/Google/oauth-token");
  });

  it("returns undefined for unmatched host", () => {
    const route = matchRoute(routes, "evil.com");
    expect(route).toBeUndefined();
  });

  it("matches with method filter", () => {
    const routesWithMethod: HttpRoute[] = [
      {
        host: "api.github.com",
        method: "GET",
        credential: "AgentVault/GitHub/read-token",
        inject: { header: "authorization" },
      },
      {
        host: "api.github.com",
        credential: "AgentVault/GitHub/write-token",
        inject: { header: "authorization" },
      },
    ];
    expect(matchRoute(routesWithMethod, "api.github.com", undefined, "GET")?.credential).toBe(
      "AgentVault/GitHub/read-token"
    );
    expect(matchRoute(routesWithMethod, "api.github.com", undefined, "POST")?.credential).toBe(
      "AgentVault/GitHub/write-token"
    );
  });
});
