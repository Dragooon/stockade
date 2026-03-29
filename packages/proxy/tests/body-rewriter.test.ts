import { describe, it, expect, beforeEach, vi } from "vitest";
import { issueRef, clearAllRefs } from "../src/gateway/refs.js";
import { issueToken, clearAllTokens } from "../src/gateway/tokens.js";

// Mock credentials module
vi.mock("../src/shared/credentials.js", () => ({
  resolveCredential: vi.fn(),
}));

const { resolveCredential } = await import("../src/shared/credentials.js");
const { rewriteBody } = await import("../src/http/body-rewriter.js");

const provider = {
  read: "cat secrets/{key}",
  write: "echo '{value}' > secrets/{key}",
  update: "echo '{value}' > secrets/{key}",
  cache_ttl: 300,
};

describe("body-rewriter", () => {
  let gatewayToken: string;

  beforeEach(() => {
    clearAllRefs();
    clearAllTokens();
    vi.clearAllMocks();

    // Issue a gateway token that the refs will be scoped to
    const token = issueToken("main", ["github-token", "gmail-password"], undefined, 3600);
    gatewayToken = token.token;
  });

  it("returns original body when no refs present", async () => {
    const body = Buffer.from('{"username":"alice","password":"secret"}');
    const result = await rewriteBody(body, "application/json", provider);
    expect(result.replaced).toBe(false);
    expect(result.body).toBe(body); // same reference
  });

  it("returns original body for empty input", async () => {
    const body = Buffer.alloc(0);
    const result = await rewriteBody(body, "application/json", provider);
    expect(result.replaced).toBe(false);
  });

  it("skips binary content types", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);
    const body = Buffer.from(ref.ref);
    const result = await rewriteBody(body, "image/png", provider);
    expect(result.replaced).toBe(false);
  });

  it("replaces a single ref in JSON body", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);
    vi.mocked(resolveCredential).mockResolvedValue("ghp_real_secret_123");

    const body = Buffer.from(JSON.stringify({ token: ref.ref }));
    const result = await rewriteBody(body, "application/json", provider);

    expect(result.replaced).toBe(true);
    const parsed = JSON.parse(result.body.toString());
    expect(parsed.token).toBe("ghp_real_secret_123");
  });

  it("replaces a ref in URL-encoded body", async () => {
    const ref = issueRef(gatewayToken, "gmail-password", 300_000);
    vi.mocked(resolveCredential).mockResolvedValue("hunter2");

    const body = Buffer.from(`email=bot@gmail.com&password=${ref.ref}`);
    const result = await rewriteBody(body, "application/x-www-form-urlencoded", provider);

    expect(result.replaced).toBe(true);
    expect(result.body.toString()).toBe("email=bot@gmail.com&password=hunter2");
  });

  it("replaces multiple refs in one body", async () => {
    const ref1 = issueRef(gatewayToken, "github-token", 300_000);
    const ref2 = issueRef(gatewayToken, "gmail-password", 300_000);
    vi.mocked(resolveCredential)
      .mockResolvedValueOnce("ghp_abc")
      .mockResolvedValueOnce("pass123");

    const body = Buffer.from(JSON.stringify({ token: ref1.ref, password: ref2.ref }));
    const result = await rewriteBody(body, "application/json", provider);

    expect(result.replaced).toBe(true);
    const parsed = JSON.parse(result.body.toString());
    expect(parsed.token).toBe("ghp_abc");
    expect(parsed.password).toBe("pass123");
  });

  it("skips consumed (already-used) refs", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);
    vi.mocked(resolveCredential).mockResolvedValue("ghp_real");

    // First use
    const body = Buffer.from(ref.ref);
    await rewriteBody(body, "text/plain", provider);

    // Second use — same ref, should not be replaced
    const body2 = Buffer.from(ref.ref);
    const result2 = await rewriteBody(body2, "text/plain", provider);
    expect(result2.replaced).toBe(false);
  });

  it("skips refs whose gateway token was revoked", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);

    // Revoke the gateway token
    const { revokeToken } = await import("../src/gateway/tokens.js");
    revokeToken(gatewayToken);

    const body = Buffer.from(ref.ref);
    const result = await rewriteBody(body, "text/plain", provider);
    expect(result.replaced).toBe(false);
  });

  it("handles credential values with special characters", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);
    vi.mocked(resolveCredential).mockResolvedValue("pa$$w0rd_with\\backslash&more");

    const body = Buffer.from(`password=${ref.ref}`);
    const result = await rewriteBody(body, "text/plain", provider);

    expect(result.replaced).toBe(true);
    expect(result.body.toString()).toBe("password=pa$$w0rd_with\\backslash&more");
  });

  it("handles text/plain content type", async () => {
    const ref = issueRef(gatewayToken, "github-token", 300_000);
    vi.mocked(resolveCredential).mockResolvedValue("the_real_value");

    const body = Buffer.from(`some text with ${ref.ref} embedded`);
    const result = await rewriteBody(body, "text/plain", provider);

    expect(result.replaced).toBe(true);
    expect(result.body.toString()).toBe("some text with the_real_value embedded");
  });
});
