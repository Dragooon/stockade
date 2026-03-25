import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelMessage } from "../src/types.js";

// Mock node:readline
const mockOn = vi.fn();
const mockPrompt = vi.fn();
const mockClose = vi.fn();

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    on: mockOn,
    prompt: mockPrompt,
    close: mockClose,
  })),
}));

// Mock node:crypto
vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock node:os
vi.mock("node:os", () => ({
  userInfo: () => ({ username: "testuser" }),
}));

const { TerminalAdapter } = await import("../src/channels/terminal.js");

describe("TerminalAdapter", () => {
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn();
  });

  it("starts readline and prompts for input", () => {
    const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
    adapter.start();

    expect(mockOn).toHaveBeenCalledWith("line", expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mockPrompt).toHaveBeenCalled();
  });

  it("builds correct ChannelMessage on input", async () => {
    onMessage.mockResolvedValue("Agent response");

    const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
    adapter.start();

    // Extract the line handler
    const lineHandler = mockOn.mock.calls.find(
      (c) => c[0] === "line"
    )![1] as (line: string) => Promise<void>;

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await lineHandler("Hello agent");

    expect(onMessage).toHaveBeenCalledWith({
      scope: "terminal:test-uuid-1234:testuser",
      content: "Hello agent",
      userId: "testuser",
      platform: "terminal",
    } satisfies ChannelMessage);

    writeSpy.mockRestore();
  });

  it("ignores empty input", async () => {
    const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
    adapter.start();

    const lineHandler = mockOn.mock.calls.find(
      (c) => c[0] === "line"
    )![1] as (line: string) => Promise<void>;

    await lineHandler("   ");

    expect(onMessage).not.toHaveBeenCalled();
    // Should re-prompt
    expect(mockPrompt).toHaveBeenCalledTimes(2); // once at start, once after empty
  });

  it("prints error message on handler failure", async () => {
    onMessage.mockRejectedValue(new Error("Agent crashed"));

    const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
    adapter.start();

    const lineHandler = mockOn.mock.calls.find(
      (c) => c[0] === "line"
    )![1] as (line: string) => Promise<void>;

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await lineHandler("crash test");

    const allOutput = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(allOutput).toContain("Error: Agent crashed");

    writeSpy.mockRestore();
  });

  it("stop() closes readline", () => {
    const adapter = new TerminalAdapter({ agent: "main" }, onMessage);
    adapter.start();
    adapter.stop();

    expect(mockClose).toHaveBeenCalled();
  });
});
