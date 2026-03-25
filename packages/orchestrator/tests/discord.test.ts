import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformConfig } from "../src/types.js";

// Mock discord.js
const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();

vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockOn,
    login: mockLogin,
    destroy: mockDestroy,
    user: { tag: "TestBot#0001" },
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
}));

const { DiscordAdapter } = await import("../src/channels/discord.js");

type DiscordConfig = NonNullable<PlatformConfig["channels"]["discord"]>;

const discordConfig: DiscordConfig = {
  enabled: true,
  token: "test-token",
  bindings: [
    { server: "server-1", agent: "main", channels: "*" },
    {
      server: "server-2",
      agent: "researcher",
      channels: ["channel-a", "channel-b"],
    },
  ],
};

describe("DiscordAdapter", () => {
  let onMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn();
  });

  it("logs in with the configured token", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    expect(mockLogin).toHaveBeenCalledWith("test-token");
  });

  it("registers messageCreate, threadCreate, and ready handlers", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain("ready");
    expect(registeredEvents).toContain("messageCreate");
    expect(registeredEvents).toContain("threadCreate");
  });

  it("ignores bot messages", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    await messageHandler({
      author: { bot: true, id: "bot-id" },
      guildId: "server-1",
      channelId: "any-channel",
      content: "bot message",
      channel: { isThread: () => false, sendTyping: vi.fn() },
      reply: vi.fn(),
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores messages from unbound servers", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    await messageHandler({
      author: { bot: false, id: "user-1" },
      guildId: "unknown-server",
      channelId: "some-channel",
      content: "hello",
      channel: { isThread: () => false, sendTyping: vi.fn() },
      reply: vi.fn(),
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("builds correct scope for wildcard binding", async () => {
    onMessage.mockResolvedValue("Response");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    const mockReply = vi.fn();
    await messageHandler({
      author: { bot: false, id: "user-42" },
      guildId: "server-1",
      channelId: "any-channel",
      content: "Hello",
      channel: { isThread: () => false, sendTyping: vi.fn().mockResolvedValue(undefined) },
      reply: mockReply,
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:any-channel:user-42",
        content: "Hello",
        userId: "user-42",
        platform: "discord",
      })
    );

    expect(mockReply).toHaveBeenCalledWith("Response");
  });

  it("builds thread scope for thread messages", async () => {
    onMessage.mockResolvedValue("Thread response");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    const mockReply = vi.fn();
    await messageHandler({
      author: { bot: false, id: "user-42" },
      guildId: "server-1",
      channelId: "thread-id",
      content: "Thread msg",
      channel: {
        isThread: () => true,
        parentId: "parent-channel",
        sendTyping: vi.fn().mockResolvedValue(undefined),
      },
      reply: mockReply,
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:parent-channel:thread-id:user-42",
      })
    );
  });

  it("ignores messages from unbound channels (array binding)", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    await messageHandler({
      author: { bot: false, id: "user-1" },
      guildId: "server-2",
      channelId: "channel-z",
      content: "hello",
      channel: { isThread: () => false, sendTyping: vi.fn() },
      reply: vi.fn(),
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("routes to correct agent for array channel binding", async () => {
    onMessage.mockResolvedValue("ok");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    await messageHandler({
      author: { bot: false, id: "user-1" },
      guildId: "server-2",
      channelId: "channel-a",
      content: "hi",
      channel: { isThread: () => false, sendTyping: vi.fn().mockResolvedValue(undefined) },
      reply: vi.fn(),
    });

    expect(onMessage).toHaveBeenCalled();
  });

  it("stop() destroys the client", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    await adapter.stop();

    expect(mockDestroy).toHaveBeenCalled();
  });

  it("replies with error on handler failure", async () => {
    onMessage.mockRejectedValue(new Error("Agent down"));
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const messageHandler = mockOn.mock.calls.find(
      (c) => c[0] === "messageCreate"
    )![1] as (msg: Record<string, unknown>) => Promise<void>;

    const mockReply = vi.fn();
    await messageHandler({
      author: { bot: false, id: "user-1" },
      guildId: "server-1",
      channelId: "any",
      content: "crash",
      channel: { isThread: () => false, sendTyping: vi.fn().mockResolvedValue(undefined) },
      reply: mockReply,
    });

    expect(mockReply).toHaveBeenCalledWith("Error: Agent down");
  });
});
