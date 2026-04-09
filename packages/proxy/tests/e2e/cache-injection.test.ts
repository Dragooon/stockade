/**
 * E2E tests for cache marker injection — ZERO mocks.
 *
 * Tests the injectCacheMarkers function with real Anthropic API request
 * payloads, verifying model-aware cache_control injection (Haiku vs Opus/Sonnet).
 *
 * Covers bugs from:
 *   - 8c0853a: Fix cache injection 400 for Haiku: use standard ephemeral instead of ttl:1h
 */

import { describe, it, expect } from "vitest";
import { injectCacheMarkers } from "../../src/http/proxy.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal Anthropic messages API request body. */
function makeRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-20250514",
    system: [
      { type: "text", text: "You are a helpful assistant." },
      { type: "text", text: "Follow safety guidelines." },
      { type: "text", text: "Platform instructions here." },
    ],
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ],
    ...overrides,
  };
}

function injectAndParse(body: Record<string, unknown>): Record<string, unknown> {
  const input = Buffer.from(JSON.stringify(body), "utf8");
  const output = injectCacheMarkers(input, "api.anthropic.com", "/v1/messages");
  return JSON.parse(output.toString("utf8"));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Cache Injection E2E — real payloads", { timeout: 10_000 }, () => {
  // ── Test 1: Sonnet gets ttl:1h ──────────────────────────────────────

  it("1. Sonnet/Opus models get cache_control with ttl:1h on system blocks", () => {
    const body = makeRequestBody({ model: "claude-sonnet-4-20250514" });
    const result = injectAndParse(body);

    const system = result.system as Array<{ cache_control?: { type: string; ttl?: string } }>;

    // Last system block should have ttl:1h
    const last = system[system.length - 1];
    expect(last.cache_control).toBeDefined();
    expect(last.cache_control!.type).toBe("ephemeral");
    expect(last.cache_control!.ttl).toBe("1h");
  });

  it("2. Opus models get cache_control with ttl:1h on system blocks", () => {
    const body = makeRequestBody({ model: "claude-opus-4-20250514" });
    const result = injectAndParse(body);

    const system = result.system as Array<{ cache_control?: { type: string; ttl?: string } }>;
    const last = system[system.length - 1];
    expect(last.cache_control).toBeDefined();
    expect(last.cache_control!.type).toBe("ephemeral");
    expect(last.cache_control!.ttl).toBe("1h");
  });

  // ── Test 2: Haiku gets standard ephemeral (NO ttl) ─────────────────

  it("3. Haiku models get cache_control WITHOUT ttl (standard ephemeral)", () => {
    const body = makeRequestBody({ model: "claude-haiku-4-5-20251001" });
    const result = injectAndParse(body);

    const system = result.system as Array<{ cache_control?: { type: string; ttl?: string } }>;
    const last = system[system.length - 1];
    expect(last.cache_control).toBeDefined();
    expect(last.cache_control!.type).toBe("ephemeral");
    expect(last.cache_control!.ttl).toBeUndefined();
  });

  // ── Test 3: Haiku strips ttl from SDK-set message markers ──────────

  it("4. Haiku strips ttl from pre-existing message cache markers", () => {
    const body = makeRequestBody({
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: [{ type: "text", text: "How are you?", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    });

    const result = injectAndParse(body);

    const messages = result.messages as Array<{
      role: string;
      content: string | Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;

    // All user message content blocks should have NO ttl
    for (const msg of messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.cache_control) {
          expect(block.cache_control.ttl).toBeUndefined();
          expect(block.cache_control.type).toBe("ephemeral");
        }
      }
    }
  });

  // ── Test 4: Non-Haiku upgrades SDK 5m markers to 1h ────────────────

  it("5. Sonnet upgrades SDK ephemeral (5m) message markers to ttl:1h", () => {
    const body = makeRequestBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: [{ type: "text", text: "How are you?", cache_control: { type: "ephemeral" } }] },
      ],
    });

    const result = injectAndParse(body);

    const messages = result.messages as Array<{
      role: string;
      content: string | Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;

    for (const msg of messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.cache_control) {
          expect(block.cache_control.ttl).toBe("1h");
        }
      }
    }
  });

  // ── Test 5: scope:global is stripped from all models ────────────────

  it("6. scope:global is stripped from system blocks for all models", () => {
    for (const model of ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]) {
      const body = makeRequestBody({
        model,
        system: [
          { type: "text", text: "System 1", cache_control: { type: "ephemeral", scope: "global" } },
          { type: "text", text: "System 2", cache_control: { type: "ephemeral", scope: "global" } },
          { type: "text", text: "System 3" },
        ],
      });

      const result = injectAndParse(body);
      const system = result.system as Array<{ cache_control?: Record<string, unknown> }>;

      for (const block of system) {
        if (block.cache_control) {
          expect(block.cache_control.scope).toBeUndefined();
        }
      }
    }
  });

  // ── Test 6: User message normalization (string → array) ────────────

  it("7. normalizes string user messages to array format", () => {
    const body = makeRequestBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hello there" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Second message" },
      ],
    });

    const result = injectAndParse(body);
    const messages = result.messages as Array<{ role: string; content: unknown }>;

    for (const msg of messages) {
      if (msg.role === "user") {
        expect(Array.isArray(msg.content)).toBe(true);
        const blocks = msg.content as Array<{ type: string; text: string }>;
        expect(blocks[0].type).toBe("text");
      }
    }
  });

  // ── Test 7: Second-to-last user message gets cache anchor ──────────

  it("8. second-to-last user message gets a cache anchor marker", () => {
    const body = makeRequestBody({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Second message" },
        { role: "assistant", content: "Response 2" },
        { role: "user", content: "Third message (latest)" },
      ],
    });

    const result = injectAndParse(body);
    const messages = result.messages as Array<{
      role: string;
      content: Array<{ text: string; cache_control?: { type: string; ttl?: string } }>;
    }>;

    // Find the second-to-last user message (index 2 → "Second message")
    const userMsgs = messages.filter((m) => m.role === "user");
    const secondToLast = userMsgs[userMsgs.length - 2];

    expect(Array.isArray(secondToLast.content)).toBe(true);
    const lastBlock = secondToLast.content[secondToLast.content.length - 1];
    expect(lastBlock.cache_control).toBeDefined();
    expect(lastBlock.cache_control!.type).toBe("ephemeral");
    expect(lastBlock.cache_control!.ttl).toBe("1h"); // Sonnet gets 1h
  });

  it("9. second-to-last user message gets standard ephemeral for Haiku", () => {
    const body = makeRequestBody({
      model: "claude-haiku-4-5-20251001",
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "R1" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "R2" },
        { role: "user", content: "Third" },
      ],
    });

    const result = injectAndParse(body);
    const messages = result.messages as Array<{
      role: string;
      content: Array<{ cache_control?: { type: string; ttl?: string } }>;
    }>;

    const userMsgs = messages.filter((m) => m.role === "user");
    const secondToLast = userMsgs[userMsgs.length - 2];
    const lastBlock = secondToLast.content[secondToLast.content.length - 1];
    expect(lastBlock.cache_control).toBeDefined();
    expect(lastBlock.cache_control!.type).toBe("ephemeral");
    expect(lastBlock.cache_control!.ttl).toBeUndefined(); // Haiku: no ttl
  });

  // ── Test 8: Non-Anthropic hosts are passed through unchanged ───────

  it("10. non-Anthropic host requests are passed through unchanged", () => {
    const body = makeRequestBody();
    const input = Buffer.from(JSON.stringify(body), "utf8");

    const output = injectCacheMarkers(input, "api.openai.com", "/v1/messages");
    expect(output).toBe(input); // Same buffer reference — not modified
  });

  it("11. non-messages path requests are passed through unchanged", () => {
    const body = makeRequestBody();
    const input = Buffer.from(JSON.stringify(body), "utf8");

    const output = injectCacheMarkers(input, "api.anthropic.com", "/v1/complete");
    expect(output).toBe(input);
  });

  // ── Test 9: Marker count limit (max 4) ─────────────────────────────

  it("12. does not inject markers when 4+ already exist", () => {
    const body = makeRequestBody({
      model: "claude-sonnet-4-20250514",
      system: [
        { type: "text", text: "S1", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "S2", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "S3", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "Latest" },
      ],
    });

    const result = injectAndParse(body);
    const messages = result.messages as Array<{
      role: string;
      content: Array<{ cache_control?: unknown }>;
    }>;

    // Count total markers — should not exceed the input count
    let totalMarkers = 0;
    for (const blk of (result.system as Array<{ cache_control?: unknown }>) ?? []) {
      if (blk.cache_control) totalMarkers++;
    }
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const blk of msg.content) {
        if (blk.cache_control) totalMarkers++;
      }
    }

    // We started with 4 markers; the function should not add more
    expect(totalMarkers).toBeLessThanOrEqual(4);
  });

  // ── Test 10: TTL ordering — no 1h after 5m ─────────────────────────

  it("14. Sonnet: SDK-set ephemeral (5m) on early system block is upgraded to 1h", () => {
    // Reproduces: "a ttl='1h' cache_control block must not come after a ttl='5m' block"
    // The SDK sets {type:"ephemeral"} (no ttl = 5m default) on system[2].
    // The proxy then sets ttl:"1h" on the last system block.
    // Without upgrading the early block, this creates a 5m→1h ordering violation.
    const body = makeRequestBody({
      model: "claude-sonnet-4-20250514",
      system: [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "Follow safety guidelines." },
        { type: "text", text: "SDK instructions.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Platform instructions here." },
      ],
    });

    const result = injectAndParse(body);
    const system = result.system as Array<{ cache_control?: { type: string; ttl?: string } }>;

    // Early system block must be upgraded to 1h (not left as 5m)
    expect(system[2].cache_control).toBeDefined();
    expect(system[2].cache_control!.ttl).toBe("1h");

    // Last system block also gets 1h
    const last = system[system.length - 1];
    expect(last.cache_control).toBeDefined();
    expect(last.cache_control!.ttl).toBe("1h");
  });

  it("15. Haiku: SDK-set ttl:1h on early system block is downgraded to plain ephemeral", () => {
    const body = makeRequestBody({
      model: "claude-haiku-4-5-20251001",
      system: [
        { type: "text", text: "System 1." },
        { type: "text", text: "System 2.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "System 3." },
      ],
    });

    const result = injectAndParse(body);
    const system = result.system as Array<{ cache_control?: { type: string; ttl?: string } }>;

    // Early block: ttl must be stripped for Haiku
    expect(system[1].cache_control).toBeDefined();
    expect(system[1].cache_control!.ttl).toBeUndefined();
  });

  it("16. all cache_control TTLs are monotonically non-increasing (no 1h after 5m)", () => {
    // Comprehensive ordering validation across system + messages
    for (const model of ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]) {
      const body = makeRequestBody({
        model,
        system: [
          { type: "text", text: "S1." },
          { type: "text", text: "S2.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "S3." },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "How are you?" },
        ],
      });

      const result = injectAndParse(body);

      // Collect all cache_control blocks in document order
      const ttls: (string | undefined)[] = [];
      for (const blk of (result.system as Array<{ cache_control?: { ttl?: string } }>) ?? []) {
        if (blk.cache_control) ttls.push(blk.cache_control.ttl);
      }
      for (const msg of (result.messages as Array<{ content: unknown }>) ?? []) {
        if (!Array.isArray(msg.content)) continue;
        for (const blk of msg.content) {
          if ((blk as Record<string, unknown>).cache_control) {
            ttls.push(((blk as Record<string, unknown>).cache_control as { ttl?: string }).ttl);
          }
        }
      }

      // Validate: no ttl:"1h" appears after a ttl:undefined (5m)
      let seen5m = false;
      for (const ttl of ttls) {
        if (ttl === undefined) seen5m = true;
        if (ttl === "1h" && seen5m) {
          throw new Error(
            `TTL ordering violation for ${model}: 1h marker after 5m marker. TTLs in order: [${ttls.map((t) => t ?? "5m").join(", ")}]`
          );
        }
      }
    }
  });

  // ── Test 11: Malformed JSON is returned unchanged ──────────────────

  it("17. malformed JSON body is returned unchanged", () => {
    const garbage = Buffer.from("not valid json {{{{", "utf8");
    const output = injectCacheMarkers(garbage, "api.anthropic.com", "/v1/messages");
    expect(output.toString()).toBe("not valid json {{{{");
  });
});
