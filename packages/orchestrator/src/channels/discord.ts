import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { discordScope, discordThreadScope } from "./scope.js";
import type { ChannelMessage, PlatformConfig } from "../types.js";

type DiscordConfig = NonNullable<PlatformConfig["channels"]["discord"]>;

export class DiscordAdapter {
  private config: DiscordConfig;
  private onMessage: (msg: ChannelMessage) => Promise<string>;
  private client: Client;

  constructor(
    config: DiscordConfig,
    onMessage: (msg: ChannelMessage) => Promise<string>
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on("clientReady", () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", async (message: Message) => {
      await this.handleMessage(message);
    });

    this.client.on("threadCreate", async (thread) => {
      if (thread.joinable) await thread.join();
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Must be in a guild
    const serverId = message.guildId;
    if (!serverId) return;

    // Only respond when mentioned or in a thread the bot is in
    const isMentioned = message.mentions.has(this.client.user!.id);
    const isThread = message.channel.isThread();
    if (!isMentioned && !isThread) return;

    // Find a matching binding
    const channelId = message.channelId;
    const binding = this.findBinding(serverId, channelId);
    // For threads, check the parent channel's binding
    const parentChannelId = isThread
      ? (message.channel as unknown as { parentId: string }).parentId
      : channelId;
    const effectiveBinding = binding ?? this.findBinding(serverId, parentChannelId);
    if (!effectiveBinding) return;

    // Build scope
    const scope = isThread
      ? discordThreadScope(
          serverId,
          parentChannelId,
          channelId,
          message.author.id
        )
      : discordScope(serverId, channelId, message.author.id);

    // Strip the bot mention from content
    const content = message.content
      .replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "")
      .trim();

    if (!content) return; // empty after stripping mention

    const channelMessage: ChannelMessage = {
      scope,
      content,
      userId: message.author.id,
      platform: "discord",
    };

    // Show typing indicator
    try {
      await (message.channel as TextBasedChannel).sendTyping();
    } catch {
      // ignore typing errors
    }

    try {
      const response = await this.onMessage(channelMessage);
      // Split long messages (Discord 2000 char limit)
      const chunks = splitMessage(response, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await message.reply(`Error: ${errMsg}`);
    }
  }

  private findBinding(
    serverId: string,
    channelId: string
  ): (typeof this.config.bindings)[number] | null {
    for (const binding of this.config.bindings) {
      if (binding.server !== serverId) continue;

      const channels = binding.channels;
      if (channels === "*") return binding;
      if (typeof channels === "string" && channels === channelId)
        return binding;
      if (Array.isArray(channels) && channels.includes(channelId))
        return binding;
    }
    return null;
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}
