import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformConfig } from "../src/types.js";

// Mock discord.js
const BOT_USER_ID = "bot-123";
const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();

vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockOn,
    login: mockLogin,
    destroy: mockDestroy,
    user: { tag: "TestBot#0001", id: BOT_USER_ID },
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

/** Create a mock Discord message with bot mention */
function mockMessage(overrides: Record<string, unknown> = {}) {
  const defaults = {
    author: { bot: false, id: "user-42" },
    guildId: "server-1",
    channelId: "any-channel",
    content: `<@${BOT_USER_ID}> Hello`,
    mentions: { has: (id: string) => id === BOT_USER_ID },
    channel: { isThread: () => false, sendTyping: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn(),
  };
  return { ...defaults, ...overrides };
}

function getMessageHandler() {
  return mockOn.mock.calls.find(
    (c) => c[0] === "messageCreate"
  )![1] as (msg: Record<string, unknown>) => Promise<void>;
}

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

  it("registers messageCreate, threadCreate, and clientReady handlers", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();

    const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain("clientReady");
    expect(registeredEvents).toContain("messageCreate");
    expect(registeredEvents).toContain("threadCreate");
  });

  it("ignores bot messages", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({ author: { bot: true, id: "bot-id" } }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores messages without mention (non-thread)", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({
      content: "Hello without mention",
      mentions: { has: () => false },
    }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores messages from unbound servers", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({ guildId: "unknown-server" }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("builds correct scope and strips mention for wildcard binding", async () => {
    onMessage.mockResolvedValue("Response");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    const msg = mockMessage();
    await handler(msg);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:any-channel:user-42",
        content: "Hello", // mention stripped
        userId: "user-42",
        platform: "discord",
      })
    );

    expect(msg.reply).toHaveBeenCalledWith("Response");
  });

  it("responds to thread messages without mention", async () => {
    onMessage.mockResolvedValue("Thread response");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    const msg = mockMessage({
      channelId: "thread-id",
      content: "Thread msg",
      mentions: { has: () => false }, // no mention
      channel: {
        isThread: () => true,
        parentId: "parent-channel",
        sendTyping: vi.fn().mockResolvedValue(undefined),
      },
    });
    await handler(msg);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:parent-channel:thread-id:user-42",
        content: "Thread msg",
      })
    );
  });

  it("ignores messages from unbound channels (array binding)", async () => {
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({
      guildId: "server-2",
      channelId: "channel-z",
    }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("routes to correct agent for array channel binding", async () => {
    onMessage.mockResolvedValue("ok");
    const adapter = new DiscordAdapter(discordConfig, onMessage);
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({
      guildId: "server-2",
      channelId: "channel-a",
    }));

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
    const handler = getMessageHandler();

    const msg = mockMessage();
    await handler(msg);

    expect(msg.reply).toHaveBeenCalledWith("Error: Agent down");
  });
});
