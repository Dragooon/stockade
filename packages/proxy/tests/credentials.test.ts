import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Provider } from "../src/shared/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Mock child_process.spawn — credentials.ts uses spawn(bash, ["-c", cmd], opts)
// and reads stdout/stderr from the returned ChildProcess. Each invocation
// returns an event-emitter that emits one stdout chunk and an "exit" event,
// optionally with a non-zero code to simulate failure.
// ──────────────────────────────────────────────────────────────────────────
let _mockStdout = "";
let _mockShouldReject = false;
let _mockRejectError: Error | null = null;
let _mockRejectOnce: Error[] = [];
// Optional per-call handler. If set, it overrides _mockStdout for each invocation.
// Receives the spawn args (file, args, opts) and returns { stdout, stderr?, code? }.
let _mockHandler: ((args: any[]) => { stdout: string; stderr?: string; code?: number }) | null = null;

const mockExecFile = vi.fn((..._args: any[]) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let stdout = _mockStdout;
  let stderr = "";
  let exitCode = 0;
  if (_mockHandler) {
    const result = _mockHandler(_args);
    stdout = result.stdout;
    stderr = result.stderr ?? "";
    exitCode = result.code ?? 0;
  } else if (_mockRejectOnce.length > 0) {
    const err = _mockRejectOnce.shift()!;
    stderr = (err as any).stderr ?? err.message ?? "";
    exitCode = 1;
    stdout = "";
  } else if (_mockShouldReject && _mockRejectError) {
    stderr = (_mockRejectError as any).stderr ?? _mockRejectError.message ?? "";
    exitCode = 1;
    stdout = "";
  }
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("exit", exitCode, null);
  });
  return child;
});

function setMockHandler(handler: ((args: any[]) => { stdout: string; stderr?: string; code?: number }) | null) {
  _mockHandler = handler;
}

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, spawn: mockExecFile };
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
  _mockStdout = "";
  _mockShouldReject = false;
  _mockRejectError = null;
  _mockRejectOnce = [];
  _mockHandler = null;
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
  // Value passed via APW_STORE_VALUE env var, not inlined into the command.
  write: 'op item create --vault AgentVault --title {key} --category password "password=$APW_STORE_VALUE"',
  update: 'op item edit {key} --vault AgentVault "password=$APW_STORE_VALUE"',
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

  it("executes update command first with value passed via env var", async () => {
    mockResolve("");

    await storeCredential(provider, "AgentVault/New/key", "new-secret");

    expect(mockExecFile).toHaveBeenCalled();
    // {key} is substituted; the value is NOT inlined — it stays as literal
    // $APW_STORE_VALUE in the command and is passed via env.
    expect(getLastCommand()).toBe(
      'op item edit AgentVault/New/key --vault AgentVault "password=$APW_STORE_VALUE"'
    );
    const lastCallEnv = mockExecFile.mock.calls.at(-1)?.[2]?.env;
    expect(lastCallEnv?.APW_STORE_VALUE).toBe("new-secret");
  });

  it("falls back to write if update fails", async () => {
    mockRejectOnce(new Error("item not found"));
    mockResolve("");

    await storeCredential(provider, "AgentVault/New/key2", "secret2");

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(getCommandAt(1)).toBe(
      'op item create --vault AgentVault --title AgentVault/New/key2 --category password "password=$APW_STORE_VALUE"'
    );
    const writeCallEnv = mockExecFile.mock.calls[1]?.[2]?.env;
    expect(writeCallEnv?.APW_STORE_VALUE).toBe("secret2");
  });

  it("does not interpret shell metacharacters in value", async () => {
    // The injection-test value: if the value were inlined into the command,
    // these chars would break the shell. With env-var passing, they're inert.
    mockResolve("");
    const evilValue = '"; rm -rf $HOME; echo "';

    await storeCredential(provider, "AgentVault/Evil/key", evilValue);

    // Command text contains no part of the value — only $APW_STORE_VALUE.
    const cmd = getLastCommand();
    expect(cmd).not.toContain("rm -rf");
    expect(cmd).toContain("$APW_STORE_VALUE");
    const env = mockExecFile.mock.calls.at(-1)?.[2]?.env;
    expect(env?.APW_STORE_VALUE).toBe(evilValue);
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
    setMockHandler(() => {
      callCount++;
      if (callCount === 1) {
        return { stdout: "session-token-abc\n" };
      }
      return { stdout: "secret-value\n" };
    });

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
    setMockHandler((args) => {
      callCount++;
      if (callCount === 1) {
        return { stdout: "my-session-token\n" };
      }
      capturedEnv = args[2]?.env;
      return { stdout: "value\n" };
    });

    await resolveCredential(signinProvider, "Vault/Key/field");

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.MYCTL_SESSION).toBe("my-session-token");
  });

  it("re-signs in after invalidateSession", async () => {
    let callCount = 0;
    setMockHandler(() => {
      callCount++;
      if (callCount % 2 === 1) {
        return { stdout: `token-${callCount}\n` };
      }
      return { stdout: "value\n" };
    });

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
