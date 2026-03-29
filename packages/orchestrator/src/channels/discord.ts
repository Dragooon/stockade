import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type TextBasedChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import { discordScope, discordThreadScope } from "./scope.js";
import type { ChannelMessage, ChannelAttachment, PlatformConfig, AgentsConfig, ApprovalChannel } from "../types.js";
import type { GatekeeperReview, RiskLevel } from "../gatekeeper.js";

type DiscordConfig = NonNullable<PlatformConfig["channels"]["discord"]>;

/** Timeout for HITL approval buttons (10 minutes). */
const ASK_TIMEOUT_MS = 10 * 60_000;

/** Image MIME types the Anthropic API accepts as multimodal content. */
const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

/** Max sizes for attachment downloads. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 5 MB (Anthropic API limit)
const MAX_TEXT_BYTES = 50 * 1024;           // 50 KB

/** File extensions treated as text regardless of MIME type. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".tsv",
  ".ts", ".js", ".jsx", ".tsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".sh", ".bash",
  ".html", ".css", ".xml", ".toml", ".ini", ".cfg", ".env",
  ".sql", ".graphql", ".proto", ".dockerfile", ".makefile",
  ".gitignore", ".editorconfig",
]);

function isTextFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TEXT_EXTENSIONS.has(lower.slice(lower.lastIndexOf(".")));
}

/**
 * Download a Discord attachment and convert to a ChannelAttachment.
 * Images are stored as base64, text files as plain text.
 * Returns null if the attachment should be skipped.
 */
async function downloadAttachment(
  url: string,
  filename: string,
  contentType: string | null,
  size: number,
): Promise<ChannelAttachment | null> {
  const mime = contentType ?? "application/octet-stream";

  try {
    if (IMAGE_MIME_TYPES.has(mime) && size <= MAX_IMAGE_BYTES) {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return {
        filename,
        contentType: mime,
        data: Buffer.from(buf).toString("base64"),
        size,
      };
    }

    if (mime.startsWith("text/") || isTextFile(filename)) {
      if (size > MAX_TEXT_BYTES) return null;
      const res = await fetch(url);
      return {
        filename,
        contentType: mime,
        data: await res.text(),
        size,
      };
    }
  } catch {
    // Download failed — skip this attachment
  }

  return null;
}

export interface DiscordAdapterOptions {
  /** Called to handle a message and return the agent's response. */
  onMessage: (msg: ChannelMessage, approvalChannel?: ApprovalChannel) => Promise<string>;
  /** Called to delete a session scope. */
  onSessionReset?: (scope: string) => void;
  /** Agent registry — used to expose agent names in /agent command. */
  agents?: AgentsConfig;
}

export class DiscordAdapter {
  private config: DiscordConfig;
  private opts: DiscordAdapterOptions;
  private client: Client;
  /** Track recently processed message IDs to prevent duplicate handling. */
  private processedMessages = new Set<string>();
  /** Track message IDs we are currently processing (prevents re-entrant dispatch). */
  private inFlightMessages = new Set<string>();

  constructor(config: DiscordConfig, opts: DiscordAdapterOptions) {
    this.config = config;
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on("clientReady", async () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
      await this.registerSlashCommands();
    });

    this.client.on("error", (err) => {
      console.error("[discord] Client error:", err.message);
    });

    this.client.on("warn", (msg) => {
      console.warn("[discord] Warning:", msg);
    });

    this.client.on("messageCreate", async (message: Message) => {
      await this.handleMessage(message);
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
      } catch (err) {
        // Swallow interaction errors (e.g. expired tokens) to prevent crash
        console.error("[discord] Interaction error:", err instanceof Error ? err.message : err);
      }
    });

    this.client.on("threadCreate", async (thread) => {
      if (thread.joinable) await thread.join();
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  // ── Slash Command Registration ──────────────────────────────────

  private buildSlashCommands(): SlashCommandBuilder[] {
    const commands: SlashCommandBuilder[] = [];

    // /ask <message> — talk to the channel's bound agent
    commands.push(
      new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Send a message to the AI agent")
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("Your message to the agent")
            .setRequired(true)
        ) as SlashCommandBuilder
    );

    // /new — reset session for this channel/thread
    commands.push(
      new SlashCommandBuilder()
        .setName("new")
        .setDescription(
          "Start a fresh conversation (resets session memory for this channel)"
        ) as SlashCommandBuilder
    );

    // /agent <agentId> <message> — talk to a specific agent
    const agentCmd = new SlashCommandBuilder()
      .setName("agent")
      .setDescription("Send a message to a specific agent")
      .addStringOption((opt) => {
        opt
          .setName("agent_id")
          .setDescription("Which agent to talk to")
          .setRequired(true);

        // Add agent names as choices if we have the registry
        if (this.opts.agents) {
          const agentIds = Object.keys(this.opts.agents.agents);
          for (const id of agentIds.slice(0, 25)) {
            // Discord max 25 choices
            opt.addChoices({ name: id, value: id });
          }
        }

        return opt;
      })
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("Your message to the agent")
          .setRequired(true)
      ) as SlashCommandBuilder;
    commands.push(agentCmd);

    // /status — show current session info
    commands.push(
      new SlashCommandBuilder()
        .setName("status")
        .setDescription(
          "Show which agent and session is active in this channel"
        ) as SlashCommandBuilder
    );

    return commands;
  }

  private async registerSlashCommands(): Promise<void> {
    const commands = this.buildSlashCommands();
    const rest = new REST({ version: "10" }).setToken(this.config.token);
    const clientId = this.client.user!.id;

    try {
      // Register per-guild for each binding (instant availability)
      const serverIds = new Set(this.config.bindings.map((b) => b.server));
      for (const serverId of serverIds) {
        await rest.put(Routes.applicationGuildCommands(clientId, serverId), {
          body: commands.map((c) => c.toJSON()),
        });
      }
      console.log(
        `[discord] Registered ${commands.length} slash commands in ${serverIds.size} server(s)`
      );
    } catch (err) {
      console.error("[discord] Failed to register slash commands:", err);
    }
  }

  // ── Slash Command Handler ───────────────────────────────────────

  private async handleSlashCommand(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const serverId = interaction.guildId;
    if (!serverId) {
      await interaction.reply({
        content: "Slash commands only work in a server.",
        ephemeral: true,
      });
      return;
    }

    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const isThread = interaction.channel?.isThread() ?? false;
    const parentChannelId = isThread
      ? (interaction.channel as unknown as { parentId: string }).parentId
      : channelId;

    // Check binding
    const binding =
      this.findBinding(serverId, channelId) ??
      this.findBinding(serverId, parentChannelId);
    if (!binding) {
      await interaction.reply({
        content: "No agent is bound to this channel.",
        ephemeral: true,
      });
      return;
    }

    const scope = isThread
      ? discordThreadScope(serverId, parentChannelId, channelId, userId)
      : discordScope(serverId, channelId, userId);

    const commandName = interaction.commandName;

    // ── /new ──
    if (commandName === "new") {
      if (this.opts.onSessionReset) {
        this.opts.onSessionReset(scope);
      }
      await interaction.reply({
        content: "Session reset. Next message starts a fresh conversation.",
        ephemeral: true,
      });
      return;
    }

    // ── /status ──
    if (commandName === "status") {
      const agentId = binding.agent;
      await interaction.reply({
        content: [
          `**Agent:** \`${agentId}\``,
          `**Scope:** \`${scope}\``,
          `**Channel:** ${isThread ? "thread" : "channel"} \`${channelId}\``,
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }

    // ── /ask <message> ──
    if (commandName === "ask") {
      const content = interaction.options.getString("message", true);
      await this.dispatchSlashMessage(interaction, scope, content, userId);
      return;
    }

    // ── /agent <agent_id> <message> ──
    if (commandName === "agent") {
      const agentId = interaction.options.getString("agent_id", true);
      const content = interaction.options.getString("message", true);
      // Override scope to include agent routing hint
      const agentScope = isThread
        ? discordThreadScope(serverId, parentChannelId, channelId, userId)
        : discordScope(serverId, channelId, userId);

      const channelMessage: ChannelMessage = {
        scope: agentScope,
        content: `/agent:${agentId} ${content}`,
        userId,
        platform: "discord",
      };

      const channel = interaction.channel as TextBasedChannel;
      const askApproval = this.createApprovalChannel(channel, userId);

      await interaction.deferReply();
      try {
        const response = await this.opts.onMessage(channelMessage, askApproval);
        const chunks = splitMessage(response, 2000);
        await interaction.editReply(chunks[0]);
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp(chunk);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await interaction.editReply(`Error: ${errMsg}`);
      }
      return;
    }

    await interaction.reply({
      content: `Unknown command: /${commandName}`,
      ephemeral: true,
    });
  }

  private async dispatchSlashMessage(
    interaction: ChatInputCommandInteraction,
    scope: string,
    content: string,
    userId: string
  ): Promise<void> {
    const channelMessage: ChannelMessage = {
      scope,
      content,
      userId,
      platform: "discord",
    };

    const channel = interaction.channel as TextBasedChannel;
    const askApproval = this.createApprovalChannel(channel, userId);

    // Defer — agent might take a while
    await interaction.deferReply();

    try {
      const response = await this.opts.onMessage(channelMessage, askApproval);
      const chunks = splitMessage(response, 2000);
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Error: ${errMsg}`);
    }
  }

  // ── Message handler (processes all messages in bound channels) ──

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    // Dedup: skip if we've already processed this message
    if (this.processedMessages.has(message.id)) return;
    this.processedMessages.add(message.id);
    // Prune old entries to prevent memory leak (keep last 100)
    if (this.processedMessages.size > 100) {
      const entries = [...this.processedMessages];
      for (let i = 0; i < entries.length - 100; i++) {
        this.processedMessages.delete(entries[i]);
      }
    }

    const serverId = message.guildId;
    if (!serverId) return;

    const isThread = message.channel.isThread();

    // Prevent concurrent dispatch for the same logical message.
    const contentKey = `${message.author.id}:${message.content}`;
    if (this.inFlightMessages.has(contentKey)) return;
    this.inFlightMessages.add(contentKey);
    // Auto-clear after processing (in the finally block below)

    const channelId = message.channelId;
    const binding = this.findBinding(serverId, channelId);
    const parentChannelId = isThread
      ? (message.channel as unknown as { parentId: string }).parentId
      : channelId;
    const effectiveBinding =
      binding ?? this.findBinding(serverId, parentChannelId);
    if (!effectiveBinding) return;

    const scope = isThread
      ? discordThreadScope(serverId, parentChannelId, channelId, message.author.id)
      : discordScope(serverId, channelId, message.author.id);

    // Strip bot mention if present (user may still @mention even though it's not required)
    const content = message.content
      .replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "")
      .trim();

    if (!content && message.attachments.size === 0) return;

    // Download attachments (images as base64, text files as string)
    const attachments: ChannelAttachment[] = [];
    for (const [, att] of message.attachments) {
      const downloaded = await downloadAttachment(
        att.url,
        att.name ?? "unknown",
        att.contentType,
        att.size,
      );
      if (downloaded) attachments.push(downloaded);
    }

    const channelMessage: ChannelMessage = {
      scope,
      content: content || "(see attached file)",
      userId: message.author.id,
      platform: "discord",
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    const askApproval = this.createApprovalChannel(
      message.channel as TextBasedChannel,
      message.author.id,
    );

    try {
      if ("sendTyping" in message.channel) {
        await (message.channel as any).sendTyping();
      }
    } catch {
      // ignore typing errors
    }

    try {
      const response = await this.opts.onMessage(channelMessage, askApproval);
      // Empty/whitespace-only response = agent chose to stay silent (shared channel filtering)
      if (!response || !response.trim()) return;
      const chunks = splitMessage(response, 2000);
      const ch = message.channel as any;
      for (const chunk of chunks) {
        await ch.send(chunk);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await (message.channel as any).send(`Error: ${errMsg}`);
    } finally {
      this.inFlightMessages.delete(contentKey);
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

  /**
   * Create an ApprovalChannel for a Discord text channel.
   *
   * Provides two rendering callbacks:
   *   - askUser: sends approval embed (with optional risk review) + buttons
   *   - notifyAutoApproved: sends informational embed (no buttons)
   *
   * No gatekeeper logic — the orchestrator decides when to call which.
   * Only the original message sender can approve/deny.
   * Times out after ASK_TIMEOUT_MS → deny.
   */
  private createApprovalChannel(channel: TextBasedChannel, senderId: string): ApprovalChannel {
    return {
      askUser: async (tool, input, review?) => {
        try {
          const ch = channel as any;
          const embed = review
            ? buildGatedApprovalEmbed(tool, input, review, ASK_TIMEOUT_MS)
            : buildApprovalEmbed(tool, input, ASK_TIMEOUT_MS);
          const row = buildApprovalButtons();

          const approvalMsg = await ch.send({
            content: `<@${senderId}>`,
            embeds: [embed],
            components: [row],
          });

          const interaction = await approvalMsg.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i: any) => i.user.id === senderId,
            time: ASK_TIMEOUT_MS,
          });

          const approved = interaction.customId === "approve";

          const resultEmbed = review
            ? buildGatedApprovalResultEmbed(tool, input, review, approved)
            : buildApprovalResultEmbed(tool, input, approved);
          const disabledRow = buildApprovalButtons(true);
          await interaction.update({
            content: null,
            embeds: [resultEmbed],
            components: [disabledRow],
          });

          return approved;
        } catch {
          // Timeout or send failure → deny
          try {
            const ch = channel as any;
            const messages = await ch.messages.fetch({ limit: 5 });
            const approvalMsg = messages.find((m: any) =>
              m.author.id === ch.client.user?.id &&
              m.embeds[0]?.title?.includes("Approval Required")
            );
            if (approvalMsg) {
              const resultEmbed = review
                ? buildGatedApprovalResultEmbed(tool, input, review, false)
                : buildApprovalResultEmbed(tool, input, false);
              const disabledRow = buildApprovalButtons(true);
              await approvalMsg.edit({
                content: null,
                embeds: [resultEmbed],
                components: [disabledRow],
              });
            }
          } catch {
            // Best effort
          }
          return false;
        }
      },

      notifyAutoApproved: async (tool, input, review) => {
        try {
          const ch = channel as any;
          const embed = buildAutoApprovedEmbed(tool, input, review);
          await ch.send({ embeds: [embed] });
        } catch {
          // Best effort notification
        }
      },
    };
  }
}

// ── Embed builders ────────────────────────────────────────────────

const COLOR_PENDING = 0xffa500; // orange
const COLOR_APPROVED = 0x57f287; // green
const COLOR_DENIED = 0xed4245; // red
const COLOR_AUTO_APPROVED = 0x5865f2; // blurple — distinct from manual green

/** Map risk levels to Discord embed colors for the risk badge. */
const RISK_COLORS: Record<RiskLevel, number> = {
  low: 0x57f287,      // green
  medium: 0xfee75c,   // yellow
  high: 0xffa500,     // orange
  critical: 0xed4245, // red
};

/** Map risk levels to emoji for inline display. */
const RISK_EMOJI: Record<RiskLevel, string> = {
  low: "\u{1F7E2}",      // green circle
  medium: "\u{1F7E1}",   // yellow circle
  high: "\u{1F7E0}",     // orange circle
  critical: "\u{1F534}", // red circle
};


/** Format a tool invocation as a compact description block. */
function formatToolDescription(tool: string, input: Record<string, unknown>): string {
  const lines: string[] = [];

  if (tool === "Bash" && input.command) {
    lines.push(`\`\`\`bash\n${String(input.command).slice(0, 500)}\n\`\`\``);
  } else if (tool === "Write" || tool === "Edit" || tool === "Read") {
    const path = input.file_path ?? input.path;
    if (path) lines.push(`**Path:** \`${path}\``);
  } else if (tool === "Glob" || tool === "Grep") {
    if (input.pattern) lines.push(`**Pattern:** \`${input.pattern}\``);
    if (input.path) lines.push(`**Path:** \`${input.path}\``);
  } else {
    // Generic: show first relevant input field
    for (const key of ["url", "query", "command", "path", "pattern"]) {
      if (input[key]) {
        lines.push(`**${key}:** \`${String(input[key]).slice(0, 200)}\``);
        break;
      }
    }
  }

  if (input.description && typeof input.description === "string") {
    lines.push(input.description.slice(0, 200));
  }

  return lines.join("\n") || "*No details*";
}

function formatTimeout(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins >= 1) return `${mins}m`;
  return `${ms / 1000}s`;
}

function buildApprovalEmbed(
  tool: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): EmbedBuilder {
  const desc = formatToolDescription(tool, input);

  return new EmbedBuilder()
    .setTitle(`\`${tool}\` \u2014 Approval Required`)
    .setDescription(desc)

    .setColor(COLOR_PENDING)
    .setFooter({ text: `Expires in ${formatTimeout(timeoutMs)}` })
    .setTimestamp();
}

function buildApprovalButtons(disabled = false): ActionRowBuilder<ButtonBuilder> {
  const allowBtn = new ButtonBuilder()
    .setCustomId("approve")
    .setLabel("Allow")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  const denyBtn = new ButtonBuilder()
    .setCustomId("deny")
    .setLabel("Deny")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(allowBtn, denyBtn);
}

function buildApprovalResultEmbed(
  tool: string,
  input: Record<string, unknown>,
  approved: boolean,
): EmbedBuilder {
  const desc = formatToolDescription(tool, input);

  return new EmbedBuilder()
    .setTitle(approved ? `\`${tool}\` \u2014 Approved` : `\`${tool}\` \u2014 Denied`)
    .setDescription(desc)

    .setColor(approved ? COLOR_APPROVED : COLOR_DENIED)
    .setTimestamp();
}

// ── Gatekeeper-aware embed builders ──────────────────────────────

/** Format a risk review as a compact embed field value. */
function formatRiskReview(review: GatekeeperReview): string {
  return [
    `${RISK_EMOJI[review.risk]} **Risk: ${review.risk.toUpperCase()}**`,
    review.summary,
    `> ${review.reasoning}`,
  ].join("\n");
}

/**
 * Informational embed for auto-approved tool invocations (no buttons).
 * Sent to the channel so users can see what was approved without their input.
 */
function buildAutoApprovedEmbed(
  tool: string,
  input: Record<string, unknown>,
  review: GatekeeperReview,
): EmbedBuilder {
  const desc = formatToolDescription(tool, input);

  return new EmbedBuilder()
    .setTitle(`\`${tool}\` \u2014 Auto-Approved`)
    .setDescription(desc)
    .addFields({
      name: "Gatekeeper Review",
      value: formatRiskReview(review),
    })
    .setColor(COLOR_AUTO_APPROVED)
    .setTimestamp();
}

/**
 * Approval embed enhanced with gatekeeper risk review.
 * Shows the risk assessment to help the user make an informed decision.
 */
function buildGatedApprovalEmbed(
  tool: string,
  input: Record<string, unknown>,
  review: GatekeeperReview,
  timeoutMs: number,
): EmbedBuilder {
  const desc = formatToolDescription(tool, input);

  return new EmbedBuilder()
    .setTitle(`\`${tool}\` \u2014 Approval Required`)
    .setDescription(desc)
    .addFields({
      name: "Gatekeeper Review",
      value: formatRiskReview(review),
    })
    .setColor(RISK_COLORS[review.risk])
    .setFooter({ text: `Expires in ${formatTimeout(timeoutMs)}` })
    .setTimestamp();
}

/**
 * Result embed for gatekeeper-reviewed approval (after user clicks Allow/Deny).
 */
function buildGatedApprovalResultEmbed(
  tool: string,
  input: Record<string, unknown>,
  review: GatekeeperReview,
  approved: boolean,
): EmbedBuilder {
  const desc = formatToolDescription(tool, input);

  return new EmbedBuilder()
    .setTitle(approved ? `\`${tool}\` \u2014 Approved` : `\`${tool}\` \u2014 Denied`)
    .setDescription(desc)
    .addFields({
      name: "Gatekeeper Review",
      value: formatRiskReview(review),
    })
    .setColor(approved ? COLOR_APPROVED : COLOR_DENIED)
    .setTimestamp();
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
