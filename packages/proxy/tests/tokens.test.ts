import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  issueToken,
  validateToken,
  checkCredentialScope,
  checkStoreScope,
  revokeToken,
  clearAllTokens,
  initTokenStore,
} from "../src/gateway/tokens.js";

describe("gateway tokens", () => {
  beforeEach(() => {
    clearAllTokens();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a token with correct format", () => {
    const result = issueToken("main", ["AgentVault/GitHub/token"], ["AgentVault/*"], 3600);
    expect(result.token).toMatch(/^apw-main-[0-9a-f]{32}$/);
    expect(result.agentId).toBe("main");
    expect(result.credentials).toEqual(["AgentVault/GitHub/token"]);
    expect(result.storeKeys).toEqual(["AgentVault/*"]);
  });

  it("validates a valid token", () => {
    const issued = issueToken("main", ["key1"], undefined, 3600);
    const validated = validateToken(issued.token);
    expect(validated).not.toBeNull();
    expect(validated!.agentId).toBe("main");
    expect(validated!.credentials).toEqual(["key1"]);
  });

  it("rejects an unknown token", () => {
    expect(validateToken("apw-fake-0000")).toBeNull();
  });

  it("rejects an expired token", () => {
    const issued = issueToken("main", [], undefined, 10); // 10 seconds
    vi.advanceTimersByTime(11_000);
    expect(validateToken(issued.token)).toBeNull();
  });

  it("checks credential scope — allowed", () => {
    const issued = issueToken("main", ["AgentVault/GitHub/token", "AgentVault/Anthropic/api-key"], undefined, 3600);
    expect(checkCredentialScope(issued.token, "AgentVault/GitHub/token")).toBe(true);
    expect(checkCredentialScope(issued.token, "AgentVault/Anthropic/api-key")).toBe(true);
  });

  it("checks credential scope — denied", () => {
    const issued = issueToken("main", ["AgentVault/GitHub/token"], undefined, 3600);
    expect(checkCredentialScope(issued.token, "AgentVault/Secret/other")).toBe(false);
  });

  it("checks store scope — allowed with glob", () => {
    const issued = issueToken("main", [], ["AgentVault/*"], 3600);
    expect(checkStoreScope(issued.token, "AgentVault/GitHub/new-token")).toBe(true);
    expect(checkStoreScope(issued.token, "AgentVault/SSH/deploy-key")).toBe(true);
  });

  it("checks store scope — unrestricted when storeKeys is undefined", () => {
    const issued = issueToken("researcher", ["key1"], undefined, 3600);
    expect(checkStoreScope(issued.token, "AgentVault/anything")).toBe(true);
    expect(checkStoreScope(issued.token, "completely/different/key")).toBe(true);
  });

  it("checks store scope — unrestricted when storeKeys is empty", () => {
    const issued = issueToken("researcher", ["key1"], [], 3600);
    expect(checkStoreScope(issued.token, "any/key")).toBe(true);
  });

  it("checks store scope — denied with non-matching pattern", () => {
    const issued = issueToken("main", [], ["OtherVault/*"], 3600);
    expect(checkStoreScope(issued.token, "AgentVault/GitHub/token")).toBe(false);
  });

  it("revokes a token", () => {
    const issued = issueToken("main", ["key1"], undefined, 3600);
    expect(validateToken(issued.token)).not.toBeNull();
    revokeToken(issued.token);
    expect(validateToken(issued.token)).toBeNull();
  });

  it("credential scope check fails for expired token", () => {
    const issued = issueToken("main", ["key1"], undefined, 10);
    vi.advanceTimersByTime(11_000);
    expect(checkCredentialScope(issued.token, "key1")).toBe(false);
  });
});

describe("gateway token store", () => {
  let dir: string;
  let store: string;

  beforeEach(() => {
    clearAllTokens();
    dir = mkdtempSync(join(tmpdir(), "apw-tokens-"));
    store = join(dir, "gateway-tokens.json");
  });

  afterEach(() => {
    clearAllTokens();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Drop the in-memory tokens and load the file, as a fresh proxy process would. */
  function restart() {
    clearAllTokens();
    initTokenStore(store);
  }

  it("keeps issued tokens across a restart", () => {
    initTokenStore(store);
    const issued = issueToken("main", ["*"], ["Agent/*"], 3600);
    restart();
    expect(validateToken(issued.token)).toMatchObject({ agentId: "main", credentials: ["*"], storeKeys: ["Agent/*"] });
    expect(checkCredentialScope(issued.token, "seedbox-ssh-key")).toBe(true);
  });

  it("doesn't bring back revoked or expired tokens", () => {
    initTokenStore(store);
    const revoked = issueToken("main", ["*"], undefined, 3600);
    const expiring = issueToken("main", ["*"], undefined, 1);
    revokeToken(revoked.token);
    const t = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t + 2_000);
    restart();
    expect(validateToken(revoked.token)).toBeNull();
    expect(validateToken(expiring.token)).toBeNull();
    vi.restoreAllMocks();
  });

  it("starts empty when the file is missing or unreadable", () => {
    initTokenStore(store);
    expect(validateToken("apw-main-0000")).toBeNull();
    writeFileSync(store, "not json");
    restart();
    expect(issueToken("main", [], undefined, 60).token).toMatch(/^apw-main-/);
  });
});
