import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Provider } from "../src/shared/types.js";

// Mock execa before importing the module
const mockExecaCommand = vi.fn();
vi.mock("execa", () => ({
  execaCommand: mockExecaCommand,
}));

const {
  resolveCredential,
  storeCredential,
  invalidateCache,
  getCacheSize,
} = await import("../src/shared/credentials.js");

const provider: Provider = {
  read: "op read op://{key}",
  write: "op item create --vault AgentVault --title {key} --category password password={value}",
  update: "op item edit {key} --vault AgentVault password={value}",
  cache_ttl: 60,
};

describe("resolveCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });

  it("executes provider read command with key substituted", async () => {
    mockExecaCommand.mockResolvedValue({ stdout: "secret-value-123\n" });

    const result = await resolveCredential(provider, "AgentVault/GitHub/token");

    expect(result).toBe("secret-value-123");
    expect(mockExecaCommand).toHaveBeenCalledWith(
      "op read op://AgentVault/GitHub/token",
      { shell: true }
    );
  });

  it("returns cached value on second call", async () => {
    mockExecaCommand.mockResolvedValue({ stdout: "cached-value" });

    await resolveCredential(provider, "AgentVault/Test/key1");
    await resolveCredential(provider, "AgentVault/Test/key1");

    expect(mockExecaCommand).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache invalidation", async () => {
    mockExecaCommand.mockResolvedValue({ stdout: "value1" });
    await resolveCredential(provider, "AgentVault/Test/key2");

    invalidateCache("AgentVault/Test/key2");
    mockExecaCommand.mockResolvedValue({ stdout: "value2" });
    const result = await resolveCredential(provider, "AgentVault/Test/key2");

    expect(result).toBe("value2");
    expect(mockExecaCommand).toHaveBeenCalledTimes(2);
  });

  it("throws on provider failure", async () => {
    mockExecaCommand.mockRejectedValue(new Error("op: not found"));

    await expect(
      resolveCredential(provider, "AgentVault/Missing/key")
    ).rejects.toThrow("op: not found");
  });

  it("re-fetches after cache TTL expires", async () => {
    // Use a provider with 0 TTL
    const zeroTtl: Provider = { ...provider, cache_ttl: 0 };
    mockExecaCommand.mockResolvedValue({ stdout: "val" });

    await resolveCredential(zeroTtl, "AgentVault/Ttl/key");
    // With 0 TTL, the entry expires immediately
    await resolveCredential(zeroTtl, "AgentVault/Ttl/key");

    expect(mockExecaCommand).toHaveBeenCalledTimes(2);
  });
});

describe("storeCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache();
  });

  it("executes update command first", async () => {
    mockExecaCommand.mockResolvedValue({ stdout: "" });

    await storeCredential(provider, "AgentVault/New/key", "new-secret");

    expect(mockExecaCommand).toHaveBeenCalledTimes(1);
    expect(mockExecaCommand).toHaveBeenCalledWith(
      "op item edit AgentVault/New/key --vault AgentVault password=new-secret",
      { shell: true }
    );
  });

  it("falls back to write if update fails", async () => {
    mockExecaCommand
      .mockRejectedValueOnce(new Error("item not found"))
      .mockResolvedValueOnce({ stdout: "" });

    await storeCredential(provider, "AgentVault/New/key2", "secret2");

    expect(mockExecaCommand).toHaveBeenCalledTimes(2);
    expect(mockExecaCommand).toHaveBeenLastCalledWith(
      "op item create --vault AgentVault --title AgentVault/New/key2 --category password password=secret2",
      { shell: true }
    );
  });

  it("invalidates cache after store", async () => {
    // First, cache a value
    mockExecaCommand.mockResolvedValue({ stdout: "old-value" });
    await resolveCredential(provider, "AgentVault/Cache/key");
    expect(getCacheSize()).toBe(1);

    // Store should invalidate
    mockExecaCommand.mockResolvedValue({ stdout: "" });
    await storeCredential(provider, "AgentVault/Cache/key", "new-value");

    // Next resolve should re-fetch
    mockExecaCommand.mockResolvedValue({ stdout: "new-value" });
    const result = await resolveCredential(provider, "AgentVault/Cache/key");
    expect(result).toBe("new-value");
  });
});
