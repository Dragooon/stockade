import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  issueRef,
  consumeRef,
  sweepRefs,
  clearAllRefs,
  refCount,
} from "../src/gateway/refs.js";

describe("credential reference tokens", () => {
  beforeEach(() => {
    clearAllRefs();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a ref with correct format", () => {
    const ref = issueRef("apw-main-abc", "github-token", 300_000);
    expect(ref.ref).toMatch(/^apw-ref:github-token:[0-9a-f]{32}$/);
    expect(ref.credentialKey).toBe("github-token");
    expect(ref.gatewayToken).toBe("apw-main-abc");
    expect(ref.consumed).toBe(false);
  });

  it("issues refs with multi-segment keys", () => {
    const ref = issueRef("apw-main-abc", "AgentVault/GitHub/token", 300_000);
    expect(ref.ref).toMatch(/^apw-ref:AgentVault\/GitHub\/token:[0-9a-f]{32}$/);
    expect(ref.credentialKey).toBe("AgentVault/GitHub/token");
  });

  it("consumes a ref on first call", () => {
    const issued = issueRef("apw-main-abc", "key1", 300_000);
    const consumed = consumeRef(issued.ref);
    expect(consumed).not.toBeNull();
    expect(consumed!.credentialKey).toBe("key1");
    expect(consumed!.consumed).toBe(true);
  });

  it("returns null on second consume (one-time use)", () => {
    const issued = issueRef("apw-main-abc", "key1", 300_000);
    consumeRef(issued.ref);
    expect(consumeRef(issued.ref)).toBeNull();
  });

  it("returns null for unknown ref", () => {
    expect(consumeRef("apw-ref:fake:00000000000000000000000000000000")).toBeNull();
  });

  it("returns null for expired ref", () => {
    const issued = issueRef("apw-main-abc", "key1", 5_000); // 5 seconds
    vi.advanceTimersByTime(6_000);
    expect(consumeRef(issued.ref)).toBeNull();
  });

  it("sweeps expired and consumed refs", () => {
    issueRef("apw-main-abc", "key1", 5_000);
    const ref2 = issueRef("apw-main-abc", "key2", 300_000);
    consumeRef(ref2.ref); // consumed

    expect(refCount()).toBe(2);

    vi.advanceTimersByTime(6_000); // key1 expired
    const removed = sweepRefs();

    expect(removed).toBe(2); // 1 expired + 1 consumed
    expect(refCount()).toBe(0);
  });

  it("clearAllRefs empties the store", () => {
    issueRef("apw-main-abc", "key1", 300_000);
    issueRef("apw-main-abc", "key2", 300_000);
    expect(refCount()).toBe(2);
    clearAllRefs();
    expect(refCount()).toBe(0);
  });

  it("each ref gets a unique nonce", () => {
    const a = issueRef("apw-main-abc", "key1", 300_000);
    const b = issueRef("apw-main-abc", "key1", 300_000);
    expect(a.ref).not.toBe(b.ref);
  });
});
