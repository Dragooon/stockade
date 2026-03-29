import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlatformConfig } from "../src/types.js";

// Mock discord.js
const BOT_USER_ID = "bot-123";
const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn();

vi.mock("discord.js", () => {
  const MockClient = function (this: Record<string, unknown>) {
    this.on = mockOn;
    this.login = mockLogin;
    this.destroy = mockDestroy;
    this.user = { tag: "TestBot#0001", id: BOT_USER_ID };
  } as unknown as { new (opts: unknown): Record<string, unknown> };

  const MockEmbedBuilder = vi.fn().mockImplementation(() => {
    const embed: Record<string, unknown> = {};
    embed.setTitle = vi.fn().mockReturnValue(embed);
    embed.setDescription = vi.fn().mockReturnValue(embed);
    embed.setColor = vi.fn().mockReturnValue(embed);
    embed.addFields = vi.fn().mockReturnValue(embed);
    embed.setTimestamp = vi.fn().mockReturnValue(embed);
    embed.setFooter = vi.fn().mockReturnValue(embed);
    return embed;
  });

  return {
    Client: MockClient,
    EmbedBuilder: MockEmbedBuilder,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMessageReactions: 8,
    },
    REST: vi.fn().mockImplementation(() => ({
      setToken: vi.fn().mockReturnThis(),
    })),
    Routes: {
      applicationGuildCommands: vi.fn(),
    },
    SlashCommandBuilder: vi.fn().mockImplementation(() => {
      const builder: Record<string, unknown> = {};
      builder.setName = vi.fn().mockReturnValue(builder);
      builder.setDescription = vi.fn().mockReturnValue(builder);
      builder.addStringOption = vi.fn().mockReturnValue(builder);
      builder.toJSON = vi.fn().mockReturnValue({});
      return builder;
    }),
  };
});

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

/** Create a mock Discord message */
function mockMessage(overrides: Record<string, unknown> = {}) {
  const defaults = {
    author: { bot: false, id: "user-42" },
    guildId: "server-1",
    channelId: "any-channel",
    content: `<@${BOT_USER_ID}> Hello`,
    mentions: { has: (id: string) => id === BOT_USER_ID },
    channel: {
      isThread: () => false,
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn(),
    attachments: new Map(),
  };
  return { ...defaults, ...overrides };
}

function getMessageHandler() {
  return mockOn.mock.calls.find(
    (c) => c[0] === "messageCreate"
  )![1] as (msg: Record<string, unknown>) => Promise<void>;
}

function getInteractionHandler() {
  return mockOn.mock.calls.find(
    (c) => c[0] === "interactionCreate"
  )?.[1] as ((interaction: Record<string, unknown>) => Promise<void>) | undefined;
}

describe("DiscordAdapter", () => {
  let onMessage: ReturnType<typeof vi.fn>;
  let onSessionReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn();
    onSessionReset = vi.fn();
  });

  it("logs in with the configured token", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();

    expect(mockLogin).toHaveBeenCalledWith("test-token");
  });

  it("registers messageCreate, interactionCreate, threadCreate, and clientReady handlers", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();

    const registeredEvents = mockOn.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain("clientReady");
    expect(registeredEvents).toContain("messageCreate");
    expect(registeredEvents).toContain("interactionCreate");
    expect(registeredEvents).toContain("threadCreate");
  });

  it("ignores bot messages", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({ author: { bot: true, id: "bot-id" } }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("processes messages without mention (all messages in bound channels)", async () => {
    onMessage.mockResolvedValue("Response");
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    const msg = mockMessage({
      content: "Hello without mention",
      mentions: { has: () => false },
    });
    await handler(msg);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Hello without mention" }),
      expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
    );
  });

  it("ignores messages from unbound servers", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({ guildId: "unknown-server" }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("builds correct scope and strips mention for wildcard binding", async () => {
    onMessage.mockResolvedValue("Response");
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
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
      }),
      expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
    );

    expect((msg.channel as any).send).toHaveBeenCalledWith("Response");
  });

  it("responds to thread messages without mention", async () => {
    onMessage.mockResolvedValue("Thread response");
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
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
        send: vi.fn().mockResolvedValue(undefined),
      },
    });
    await handler(msg);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:parent-channel:thread-id:user-42",
        content: "Thread msg",
      }),
      expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
    );
  });

  it("ignores messages from unbound channels (array binding)", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
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
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    await handler(mockMessage({
      guildId: "server-2",
      channelId: "channel-a",
    }));

    expect(onMessage).toHaveBeenCalled();
  });

  it("stop() destroys the client", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    await adapter.stop();

    expect(mockDestroy).toHaveBeenCalled();
  });

  it("stays silent when agent returns empty response (shared channel filtering)", async () => {
    onMessage.mockResolvedValue("");
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    const msg = mockMessage({ content: "casual chatter between users" });
    await handler(msg);

    expect(onMessage).toHaveBeenCalled();
    expect((msg.channel as any).send).not.toHaveBeenCalled();
  });

  it("replies with error on handler failure", async () => {
    onMessage.mockRejectedValue(new Error("Agent down"));
    const adapter = new DiscordAdapter(discordConfig, { onMessage });
    await adapter.start();
    const handler = getMessageHandler();

    const msg = mockMessage();
    await handler(msg);

    expect((msg.channel as any).send).toHaveBeenCalledWith("Error: Agent down");
  });
});

describe("Discord slash commands", () => {
  let onMessage: ReturnType<typeof vi.fn>;
  let onSessionReset: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = vi.fn();
    onSessionReset = vi.fn();
  });

  function mockInteraction(overrides: Record<string, unknown> = {}) {
    const defaults = {
      isChatInputCommand: () => true,
      guildId: "server-1",
      channelId: "any-channel",
      user: { id: "user-42" },
      channel: { isThread: () => false },
      commandName: "ask",
      options: {
        getString: (name: string) => {
          if (name === "message") return "Hello from slash";
          if (name === "agent_id") return "main";
          return null;
        },
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };
    return { ...defaults, ...overrides };
  }

  it("/ask dispatches to the agent and replies", async () => {
    onMessage.mockResolvedValue("Slash response");
    const adapter = new DiscordAdapter(discordConfig, { onMessage, onSessionReset });
    await adapter.start();
    const handler = getInteractionHandler()!;
    expect(handler).toBeDefined();

    const interaction = mockInteraction({ commandName: "ask" });
    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:any-channel:user-42",
        content: "Hello from slash",
        platform: "discord",
      }),
      expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith("Slash response");
  });

  it("/new calls onSessionReset and confirms", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage, onSessionReset });
    await adapter.start();
    const handler = getInteractionHandler()!;

    const interaction = mockInteraction({ commandName: "new" });
    await handler(interaction);

    expect(onSessionReset).toHaveBeenCalledWith("discord:server-1:any-channel:user-42");
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Session reset"),
        ephemeral: true,
      })
    );
  });

  it("/status returns agent and scope info", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage, onSessionReset });
    await adapter.start();
    const handler = getInteractionHandler()!;

    const interaction = mockInteraction({ commandName: "status" });
    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("main"),
        ephemeral: true,
      })
    );
  });

  it("slash commands in threads use thread scope", async () => {
    onMessage.mockResolvedValue("Thread slash response");
    const adapter = new DiscordAdapter(discordConfig, { onMessage, onSessionReset });
    await adapter.start();
    const handler = getInteractionHandler()!;

    const interaction = mockInteraction({
      commandName: "ask",
      channelId: "thread-id-456",
      channel: { isThread: () => true, parentId: "parent-channel-123" },
    });
    await handler(interaction);

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "discord:server-1:parent-channel-123:thread-id-456:user-42",
      }),
      expect.objectContaining({ askUser: expect.any(Function), notifyAutoApproved: expect.any(Function) }),
    );
  });

  it("slash command in unbound channel returns error", async () => {
    const adapter = new DiscordAdapter(discordConfig, { onMessage, onSessionReset });
    await adapter.start();
    const handler = getInteractionHandler()!;

    const interaction = mockInteraction({
      guildId: "unknown-server",
    });
    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "No agent is bound to this channel.",
        ephemeral: true,
      })
    );
  });
});
