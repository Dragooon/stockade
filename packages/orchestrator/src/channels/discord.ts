import {
  ActionRowBuilder,
  AttachmentBuilder,
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
import type { ChannelMessage, ChannelAttachment, ChannelFile, ChannelResponse, PlatformConfig, AgentsConfig, ApprovalChannel } from "../types.js";
import type { GatekeeperReview, RiskLevel } from "../gatekeeper.js";

type DiscordConfig = NonNullable<PlatformConfig["channels"]["discord"]>;

/** Timeout for HITL approval buttons (10 minutes). */
const ASK_TIMEOUT_MS = 10 * 60_000;

/** Max attachment size — matches Discord's file upload limit. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Download a Discord attachment as base64.
 * All file types are accepted — the dispatcher saves them to the agent's
 * workspace so it can analyze any format with its tools.
 * Returns null if the file exceeds the size limit or download fails.
 */
async function downloadAttachment(
  url: string,
  filename: string,
  contentType: string | null,
  size: number,
): Promise<ChannelAttachment | null> {
  if (size > MAX_ATTACHMENT_BYTES) return null;
  const mime = contentType ?? "application/octet-stream";

  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return {
      filename,
      contentType: mime,
      data: Buffer.from(buf).toString("base64"),
      size,
    };
  } catch {
    return null;
  }
}

/** Build a Discord AttachmentBuilder from a ChannelFile.
 * Uses embedded base64 content when present (sandboxed agents whose filesystem
 * is not accessible from the host), otherwise reads from the path directly. */
function toAttachment(f: ChannelFile): AttachmentBuilder {
  const data = f.content ? Buffer.from(f.content, "base64") : f.path;
  return new AttachmentBuilder(data as any, { name: f.filename });
}

export interface DiscordAdapterOptions {
  /** Called to handle a message and return the agent's response. */
  onMessage: (msg: ChannelMessage, approvalChannel?: ApprovalChannel) => Promise<ChannelResponse>;
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

  /**
   * Deliver a message to the channel identified by scope.
   * Used by the scheduler to post task results back to the originating channel.
   *
   * Scope formats:
   *   discord:<serverId>:<channelId>           → sends to channelId
   *   discord:<serverId>:<channelId>:<threadId> → sends to threadId
   */
  async send(scope: string, text: string, files?: ChannelFile[]): Promise<void> {
    const parts = scope.split(":");
    if (parts[0] !== "discord" || parts.length < 3) return;

    // Thread scope: parts[3] is the threadId; channel scope: parts[2] is channelId
    const targetId = parts.length >= 4 ? parts[3] : parts[2];

    try {
      const channel = await this.client.channels.fetch(targetId);
      if (!channel || !channel.isSendable()) return;
      const chunks = splitMessage(text, 2000);
      const attachments = files?.map(toAttachment) ?? [];
      await (channel as any).send({ content: chunks[0], files: attachments });
      for (const chunk of chunks.slice(1)) {
        await (channel as any).send(chunk);
      }
    } catch (err) {
      console.error(`[discord] Failed to deliver scheduled task result to ${targetId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Send a brief resumption notice to each Discord channel/thread that had
   * an active session before the last restart.
   *
   * Only processes `discord:` scopes. Agent sub-scopes
   * (…:agent:<agentId>) are skipped — the parent channel scope already
   * covers them and we don't want duplicate notifications.
   *
   * Each unique channel/thread ID is notified at most once. Failures are
   * swallowed so a deleted or inaccessible channel never blocks startup.
   */
  async notifyChannelsResumed(
    sessions: { scope: string; sessionId: string }[]
  ): Promise<void> {
    const notifiedIds = new Set<string>();

    for (const { scope } of sessions) {
      if (!scope.startsWith("discord:")) continue;
      const parts = scope.split(":");

      // Minimum valid Discord scope: discord:<serverId>:<channelId>
      if (parts.length < 3) continue;

      // Skip agent sub-scopes: …:<channelOrThread>:agent:<agentId>
      // These share the parent channel and would cause duplicate notifications.
      if (parts.length >= 5 && parts[parts.length - 2] === "agent") continue;

      // Channel scope (length 3): notify parts[2] (channelId)
      // Thread scope  (length 4): notify parts[3] (threadId — send inside the thread)
      const targetId = parts.length === 4 ? parts[3] : parts[2];
      if (notifiedIds.has(targetId)) continue;
      notifiedIds.add(targetId);

      try {
        const channel = await this.client.channels.fetch(targetId);
        if (channel && channel.isSendable()) {
          await channel.send(
            "*(Session resumed — continuing from before restart.)*"
          );
        }
      } catch {
        // Best-effort — channel may be deleted or the bot may lack access
      }
    }
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
      ? discordThreadScope(serverId, parentChannelId, channelId)
      : discordScope(serverId, channelId);

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
        ? discordThreadScope(serverId, parentChannelId, channelId)
        : discordScope(serverId, channelId);

      const channelMessage: ChannelMessage = {
        scope: agentScope,
        content: `/agent:${agentId} ${content}`,
        userId,
        platform: "discord",
      };

      const channel = interaction.channel as TextBasedChannel;
      const askApproval = this.createApprovalChannel(channel, userId);

      await interaction.deferReply();
      this.opts.onMessage(channelMessage, askApproval).then(async (response) => {
        const { text, files } = response;
        const chunks = splitMessage(text, 2000);
        const attachments = files?.map(toAttachment) ?? [];
        await interaction.editReply({ content: chunks[0], files: attachments });
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp(chunk);
        }
      }).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        await interaction.editReply(`Error: ${errMsg}`).catch(() => {});
      });
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

    // Defer immediately — agent might take a while. editReply fires when ready.
    await interaction.deferReply();
    this.opts.onMessage(channelMessage, askApproval).then(async (response) => {
      const { text, files } = response;
      const chunks = splitMessage(text, 2000);
      const attachments = files?.map(toAttachment) ?? [];
      await interaction.editReply({ content: chunks[0], files: attachments });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    }).catch(async (err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Error: ${errMsg}`).catch(() => {});
    });
  }

  // ── Message handler (processes all messages in bound channels) ──

  private async handleMessage(message: Message): Promise<void> {
    // Block external bots; allow the bot's own [TEST] prefixed messages
    if (message.author.bot) {
      const isSelf = message.author.id === this.client.user?.id;
      if (!isSelf || !message.content.startsWith("[TEST]")) return;
    }

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
      ? discordThreadScope(serverId, parentChannelId, channelId)
      : discordScope(serverId, channelId);

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

    // Keep typing indicator alive throughout dispatch (refreshes every 8s)
    const ch = message.channel as any;
    const startTyping = () => {
      try { ch.sendTyping?.(); } catch { /* ignore */ }
    };
    startTyping();
    const typingInterval = setInterval(startTyping, 8_000);

    const cleanup = () => {
      clearInterval(typingInterval);
      this.inFlightMessages.delete(contentKey);
    };

    // Fire-and-forget: return immediately, deliver response when agent finishes.
    // The session persists per-scope; this message is injected into the running
    // session (or queued for the next turn) without blocking the channel handler.
    this.opts.onMessage(channelMessage, askApproval).then(async (response) => {
      cleanup();
      const { text, files } = response;
      // Empty/whitespace-only = agent chose to stay silent (shared channel filtering)
      if (!text?.trim()) return;
      const chunks = splitMessage(text, 2000);
      const attachments = files?.map(toAttachment) ?? [];
      await ch.send({ content: chunks[0], files: attachments });
      for (const chunk of chunks.slice(1)) {
        await ch.send(chunk);
      }
    }).catch(async (err) => {
      cleanup();
      const errMsg = err instanceof Error ? err.message : String(err);
      await ch.send(`Error: ${errMsg}`).catch(() => {});
    });
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


/** Format a tool invocation as a compact description block with full arguments. */
function formatToolDescription(tool: string, input: Record<string, unknown>): string {
  const lines: string[] = [];

  // Primary display — tool-specific formatting for the main argument
  if (tool === "Bash" && input.command) {
    lines.push(`\`\`\`bash\n${String(input.command).slice(0, 500)}\n\`\`\``);
  } else if (tool === "Edit") {
    const path = input.file_path ?? input.path;
    if (path) lines.push(`**Path:** \`${path}\``);
    if (input.old_string && input.new_string) {
      const oldLines = String(input.old_string).slice(0, 400).split("\n").map(l => `- ${l}`);
      const newLines = String(input.new_string).slice(0, 400).split("\n").map(l => `+ ${l}`);
      lines.push(`\`\`\`diff\n${oldLines.join("\n")}\n${newLines.join("\n")}\n\`\`\``);
      if (input.replace_all) lines.push("*(replace all occurrences)*");
    }
  } else if (tool === "Write" || tool === "Read") {
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

  // Full arguments — show remaining keys not already displayed above
  const shownKeys = new Set(["command", "description"]);
  if (tool === "Edit") shownKeys.add("file_path").add("path").add("old_string").add("new_string").add("replace_all");
  else if (tool === "Write" || tool === "Read") shownKeys.add("file_path").add("path");
  if (tool === "Glob" || tool === "Grep") shownKeys.add("pattern").add("path");

  const remaining = Object.entries(input).filter(
    ([k, v]) => !shownKeys.has(k) && v !== undefined && v !== null
  );
  if (remaining.length > 0) {
    const argLines = remaining.map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${val.length > 300 ? val.slice(0, 300) + "…" : val}`;
    });
    lines.push(`\`\`\`yaml\n${argLines.join("\n")}\n\`\`\``);
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
  return `${RISK_EMOJI[review.risk]} **${review.risk.toUpperCase()}** — ${review.summary}`;
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
