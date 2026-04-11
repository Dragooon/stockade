import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";
import type { Provider } from "../src/shared/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Mock child_process.execFile — credentials.ts uses promisify(execFile).
// The mock must work with util.promisify, which checks for a custom symbol.
// ──────────────────────────────────────────────────────────────────────────
let _mockStdout = "";
let _mockShouldReject = false;
let _mockRejectError: Error | null = null;
let _mockRejectOnce: Error[] = [];

// We track calls separately since the promisify.custom path bypasses the callback.
const mockExecFile = vi.fn();

// Custom promisify so util.promisify(execFile) returns {stdout, stderr}
const defaultPromisifyCustom = (...args: any[]) => {
  // Track the call on the vi.fn for toHaveBeenCalled / toHaveBeenCalledTimes
  mockExecFile(...args);
  if (_mockRejectOnce.length > 0) {
    return Promise.reject(_mockRejectOnce.shift());
  }
  if (_mockShouldReject && _mockRejectError) {
    return Promise.reject(_mockRejectError);
  }
  return Promise.resolve({ stdout: _mockStdout, stderr: "" });
};
(mockExecFile as any)[promisify.custom] = defaultPromisifyCustom;

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, execFile: mockExecFile };
});

function mockResolve(stdout: string) {
  _mockStdout = stdout;
  _mockShouldReject = false;
  _mockRejectError = null;
}

function mockReject(err: Error) {
  _mockShouldReject = true;
  _mockRejectError = err;
}

function mockRejectOnce(err: Error) {
  _mockRejectOnce.push(err);
}

function mockClearAll() {
  mockExecFile.mockClear();
  (mockExecFile as any)[promisify.custom] = defaultPromisifyCustom;
  _mockStdout = "";
  _mockShouldReject = false;
  _mockRejectError = null;
  _mockRejectOnce = [];
}

// ──────────────────────────────────────────────────────────────────────────

const {
  resolveCredential,
  storeCredential,
  invalidateCache,
  invalidateSession,
  getCacheSize,
} = await import("../src/shared/credentials.js");

const provider: Provider = {
  read: "op read op://{key}",
  write: "op item create --vault AgentVault --title {key} --category password password={value}",
  update: "op item edit {key} --vault AgentVault password={value}",
  cache_ttl: 60,
  overrides: [],
};

// Helper: extract the shell command from the mock call args.
// execFile is called as execFile(bash, ["-c", cmd], cb) — we want the cmd.
function getLastCommand(): string {
  const calls = mockExecFile.mock.calls;
  const last = calls[calls.length - 1];
  // args[1] is the ["-c", cmd] array
  return last?.[1]?.[1] ?? "";
}

function getCommandAt(index: number): string {
  const call = mockExecFile.mock.calls[index];
  return call?.[1]?.[1] ?? "";
}

describe("resolveCredential", () => {
  beforeEach(() => {
    mockClearAll();
    invalidateCache();
  });

  it("executes provider read command with key substituted", async () => {
    mockResolve("secret-value-123\n");

    const result = await resolveCredential(provider, "AgentVault/GitHub/token");

    expect(result).toBe("secret-value-123");
    expect(mockExecFile).toHaveBeenCalled();
    expect(getLastCommand()).toBe("op read op://AgentVault/GitHub/token");
  });

  it("returns cached value on second call", async () => {
    mockResolve("cached-value");

    await resolveCredential(provider, "AgentVault/Test/key1");
    await resolveCredential(provider, "AgentVault/Test/key1");

    // promisify.custom calls mockExecFile twice per invocation (once to track, once for cb)
    // but resolveCredential should only call execProviderCommand once (second is cached)
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache invalidation", async () => {
    mockResolve("value1");
    await resolveCredential(provider, "AgentVault/Test/key2");

    invalidateCache("AgentVault/Test/key2");
    mockResolve("value2");
    const result = await resolveCredential(provider, "AgentVault/Test/key2");

    expect(result).toBe("value2");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("throws on provider failure", async () => {
    mockReject(new Error("op: not found"));

    await expect(
      resolveCredential(provider, "AgentVault/Missing/key")
    ).rejects.toThrow("op: not found");
  });

  it("re-fetches after cache TTL expires", async () => {
    const zeroTtl: Provider = { ...provider, cache_ttl: 0 };
    mockResolve("val");

    await resolveCredential(zeroTtl, "AgentVault/Ttl/key");
    // With 0 TTL, the entry expires immediately
    await resolveCredential(zeroTtl, "AgentVault/Ttl/key");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCredential — overrides", () => {
  beforeEach(() => {
    mockClearAll();
    invalidateCache();
  });

  it("uses override read command when key matches exactly", async () => {
    const withOverrides: Provider = {
      ...provider,
      overrides: [
        { match: "claude-oauth-token", read: "get-claude-token" },
      ],
    };
    mockResolve("oauth-abc");

    const result = await resolveCredential(withOverrides, "claude-oauth-token");

    expect(result).toBe("oauth-abc");
    expect(getLastCommand()).toBe("get-claude-token");
  });

  it("uses override read command when key matches glob", async () => {
    const withOverrides: Provider = {
      ...provider,
      overrides: [
        { match: "op:*", read: "op read op://{key}" },
      ],
    };
    mockResolve("from-1password");

    const result = await resolveCredential(withOverrides, "op:Vault/API/key");

    expect(result).toBe("from-1password");
    expect(getLastCommand()).toBe("op read op://op:Vault/API/key");
  });

  it("falls through to default read when no override matches", async () => {
    const withOverrides: Provider = {
      ...provider,
      overrides: [
        { match: "claude-oauth-token", read: "get-claude-token" },
      ],
    };
    mockResolve("default-value");

    await resolveCredential(withOverrides, "AgentVault/Some/key");

    expect(getLastCommand()).toBe("op read op://AgentVault/Some/key");
  });

  it("first matching override wins", async () => {
    const withOverrides: Provider = {
      ...provider,
      overrides: [
        { match: "special-*", read: "first-backend {key}" },
        { match: "special-key", read: "second-backend {key}" },
      ],
    };
    mockResolve("first-wins");

    await resolveCredential(withOverrides, "special-key");

    expect(getLastCommand()).toBe("first-backend special-key");
  });
});

describe("storeCredential", () => {
  beforeEach(() => {
    mockClearAll();
    invalidateCache();
  });

  it("executes update command first", async () => {
    mockResolve("");

    await storeCredential(provider, "AgentVault/New/key", "new-secret");

    expect(mockExecFile).toHaveBeenCalled();
    expect(getLastCommand()).toBe(
      "op item edit AgentVault/New/key --vault AgentVault password=new-secret"
    );
  });

  it("falls back to write if update fails", async () => {
    mockRejectOnce(new Error("item not found"));
    mockResolve("");

    await storeCredential(provider, "AgentVault/New/key2", "secret2");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    // Second call should be the write command
    expect(getCommandAt(1)).toBe(
      "op item create --vault AgentVault --title AgentVault/New/key2 --category password password=secret2"
    );
  });

  it("invalidates cache after store", async () => {
    // First, cache a value
    mockResolve("old-value");
    await resolveCredential(provider, "AgentVault/Cache/key");
    expect(getCacheSize()).toBe(1);

    // Store should invalidate
    mockResolve("");
    await storeCredential(provider, "AgentVault/Cache/key", "new-value");

    // Next resolve should re-fetch
    mockResolve("new-value");
    const result = await resolveCredential(provider, "AgentVault/Cache/key");
    expect(result).toBe("new-value");
  });
});

describe("provider session management", () => {
  const signinProvider: Provider = {
    read: "myctl read {key}",
    signin: "myctl auth login --raw",
    session_env: "MYCTL_SESSION",
    cache_ttl: 60,
    overrides: [],
  };

  beforeEach(() => {
    mockClearAll();
    invalidateCache();
    invalidateSession();
  });

  it("runs signin once then reuses session for subsequent commands", async () => {
    let callCount = 0;
    (mockExecFile as any)[promisify.custom] = (...args: any[]) => {
      mockExecFile(...args);
      callCount++;
      if (callCount === 1) {
        // signin call
        return Promise.resolve({ stdout: "session-token-abc\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "secret-value\n", stderr: "" });
    };

    const result = await resolveCredential(signinProvider, "Vault/Item/field");
    expect(result).toBe("secret-value");
    // 2 calls: 1 signin + 1 read
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    // Second resolve (different key, no credential cache) — should NOT signin again
    invalidateCache();
    const result2 = await resolveCredential(signinProvider, "Vault/Item/field2");
    expect(result2).toBe("secret-value");
    // 3 total: 1 signin + 2 reads (no second signin)
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("injects session_env into child process environment", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let callCount = 0;
    (mockExecFile as any)[promisify.custom] = (...args: any[]) => {
      mockExecFile(...args);
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ stdout: "my-session-token\n", stderr: "" });
      }
      capturedEnv = args[2]?.env;
      return Promise.resolve({ stdout: "value\n", stderr: "" });
    };

    await resolveCredential(signinProvider, "Vault/Key/field");

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.MYCTL_SESSION).toBe("my-session-token");
  });

  it("re-signs in after invalidateSession", async () => {
    let callCount = 0;
    (mockExecFile as any)[promisify.custom] = (...args: any[]) => {
      mockExecFile(...args);
      callCount++;
      if (callCount % 2 === 1) {
        return Promise.resolve({ stdout: `token-${callCount}\n`, stderr: "" });
      }
      return Promise.resolve({ stdout: "value\n", stderr: "" });
    };

    await resolveCredential(signinProvider, "Vault/A/field");
    expect(mockExecFile).toHaveBeenCalledTimes(2); // signin + read

    invalidateSession();
    invalidateCache();

    await resolveCredential(signinProvider, "Vault/A/field");
    expect(mockExecFile).toHaveBeenCalledTimes(4); // another signin + read
  });

  it("skips signin for providers without signin config", async () => {
    mockResolve("plain-value");

    const result = await resolveCredential(provider, "Key/field");

    expect(result).toBe("plain-value");
    // Only 1 call — no signin
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
