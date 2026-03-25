import {
  Client,
  GatewayIntentBits,
  Events,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import type { ChannelAdapter, ChannelMessage } from '../types.js'
import { OrchestratorClient } from '../orchestrator-client.js'
import { buildDiscordScope, buildDiscordThreadScope } from './scope.js'
import { handleInteraction, registerCommands } from './commands.js'

const MAX_MESSAGE_LENGTH = 2000

interface DiscordBinding {
  server: string
  agent: string
  channels: string | string[]
}

export class DiscordAdapter implements ChannelAdapter {
  name = 'discord'

  private client: Client
  private token: string
  private orchestrator: OrchestratorClient
  private bindings: DiscordBinding[]

  constructor(config: {
    token: string
    orchestratorUrl: string
    bindings: DiscordBinding[]
  }) {
    this.token = config.token
    this.orchestrator = new OrchestratorClient(config.orchestratorUrl)
    this.bindings = config.bindings

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageTyping,
      ],
    })
  }

  async start(): Promise<void> {
    this.client.on(Events.ClientReady, async (client) => {
      console.log(`Discord bot logged in as ${client.user?.tag}`)

      // Register slash commands for all bound guilds
      const guildIds = [...new Set(this.bindings.map((b) => b.server))]
      try {
        await registerCommands(this.token, client.user!.id, guildIds)
      } catch (err) {
        const error = err as Error
        console.error(`Failed to register slash commands: ${error.message}`)
      }
    })

    this.client.on(Events.MessageCreate, (message: Message) => {
      this.handleMessage(message)
    })

    this.client.on(Events.ThreadCreate, (thread: ThreadChannel) => {
      this.handleThread(thread)
    })

    this.client.on(Events.InteractionCreate, (interaction) => {
      handleInteraction(interaction, this.orchestrator, this.bindings)
    })

    await this.client.login(this.token)
  }

  async stop(): Promise<void> {
    this.client.destroy()
  }

  private findBinding(
    serverId: string,
    channelId: string,
  ): DiscordBinding | undefined {
    return this.bindings.find((b) => {
      if (b.server !== serverId) return false
      if (b.channels === '*') return true
      if (Array.isArray(b.channels)) return b.channels.includes(channelId)
      return b.channels === channelId
    })
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return

    // Ignore DMs
    if (!message.guild) return

    const serverId = message.guild.id
    const channel = message.channel
    const isThread = channel.isThread()

    // For threads, check binding against parent channel
    const channelIdForBinding = isThread
      ? (channel as unknown as { parentId: string }).parentId
      : channel.id

    const binding = this.findBinding(serverId, channelIdForBinding)
    if (!binding) return

    // Build scope key
    const userId = message.author.id
    let scope: string
    if (isThread) {
      const parentId = (channel as unknown as { parentId: string }).parentId
      scope = buildDiscordThreadScope(serverId, parentId, channel.id, userId)
    } else {
      scope = buildDiscordScope(serverId, channel.id, userId)
    }

    const channelMessage: ChannelMessage = {
      scope,
      content: message.content,
      userId,
      platform: 'discord',
      metadata: {
        serverId,
        channelId: channel.id,
        agent: binding.agent,
      },
    }

    // Show typing indicator
    try {
      if ('sendTyping' in channel) {
        await channel.sendTyping()
      }
    } catch {
      // Ignore typing errors
    }

    try {
      const result = await this.orchestrator.sendMessage(channelMessage)
      await this.sendResponse(message, result.response)
    } catch (err) {
      const error = err as Error
      await message.reply(`Error: ${error.message}`).catch(() => {})
    }
  }

  private async sendResponse(message: Message, response: string): Promise<void> {
    if (response.length <= MAX_MESSAGE_LENGTH) {
      await message.reply(response)
      return
    }

    // Split into chunks
    const chunks = splitMessage(response, MAX_MESSAGE_LENGTH)
    // First chunk as a reply
    await message.reply(chunks[0])
    // Remaining chunks as channel messages
    const ch = message.channel
    if ('send' in ch) {
      for (let i = 1; i < chunks.length; i++) {
        await ch.send(chunks[i])
      }
    }
  }

  private async handleThread(thread: ThreadChannel): Promise<void> {
    // Only join threads in bound channels
    const serverId = thread.guild?.id
    const parentId = thread.parentId
    if (!serverId || !parentId) return

    const binding = this.findBinding(serverId, parentId)
    if (!binding) return

    if (thread.joinable) {
      await thread.join()
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }
    // Try to split at a newline near the limit
    let splitIndex = remaining.lastIndexOf('\n', maxLength)
    if (splitIndex <= 0) {
      // No newline found, split at maxLength
      splitIndex = maxLength
    }
    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex)
    // Remove leading newline from next chunk
    if (remaining.startsWith('\n')) {
      remaining = remaining.slice(1)
    }
  }
  return chunks
}
