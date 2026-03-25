import {
  REST,
  Routes,
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js'
import type { OrchestratorClient } from '../orchestrator-client.js'
import type { ChannelMessage } from '../types.js'
import { buildDiscordScope } from './scope.js'

interface CommandDefinition {
  name: string
  description: string
  options?: Array<{
    name: string
    description: string
    type: number
    required: boolean
  }>
}

interface DiscordBinding {
  server: string
  agent: string
  channels: string | string[]
}

export const commandDefinitions: CommandDefinition[] = [
  {
    name: 'ask',
    description: 'Send a message to the agent',
    options: [
      {
        name: 'prompt',
        description: 'Your message',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'new',
    description: 'Start a new conversation (creates a forum thread)',
    options: [
      {
        name: 'title',
        description: 'Thread title',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: 'reset',
    description: 'Clear the current session history',
  },
]

export async function registerCommands(
  token: string,
  applicationId: string,
  guildIds: string[],
): Promise<void> {
  const rest = new REST().setToken(token)

  const commandsPayload = commandDefinitions.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    options: cmd.options ?? [],
  }))

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commandsPayload,
    })
  }
}

export async function handleInteraction(
  interaction: Interaction,
  orchestrator: OrchestratorClient,
  bindings: DiscordBinding[],
): Promise<void> {
  if (!interaction.isChatInputCommand()) return

  const command = interaction as ChatInputCommandInteraction

  switch (command.commandName) {
    case 'ask':
      await handleAsk(command, orchestrator, bindings)
      break
    case 'new':
      await handleNew(command)
      break
    case 'reset':
      await handleReset(command)
      break
  }
}

function findBinding(
  serverId: string,
  channelId: string,
  bindings: DiscordBinding[],
): DiscordBinding | undefined {
  return bindings.find((b) => {
    if (b.server !== serverId) return false
    if (b.channels === '*') return true
    if (Array.isArray(b.channels)) return b.channels.includes(channelId)
    return b.channels === channelId
  })
}

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  orchestrator: OrchestratorClient,
  bindings: DiscordBinding[],
): Promise<void> {
  const prompt = interaction.options.getString('prompt')

  if (!prompt) {
    await interaction.reply({
      content: 'Please provide a prompt with the /ask command.',
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply()

  const serverId = interaction.guild?.id ?? 'unknown'
  const channelId = interaction.channel?.id ?? 'unknown'
  const userId = interaction.user.id

  const scope = buildDiscordScope(serverId, channelId, userId)

  // Look up agent binding from the interaction's guild/channel
  const binding = findBinding(serverId, channelId, bindings)

  const message: ChannelMessage = {
    scope,
    content: prompt,
    userId,
    platform: 'discord',
    metadata: {
      serverId,
      channelId,
      source: 'slash-command',
      agent: binding?.agent,
    },
  }

  try {
    const result = await orchestrator.sendMessage(message)
    await interaction.editReply(result.response)
  } catch (err) {
    const error = err as Error
    await interaction.editReply(`Error: ${error.message}`)
  }
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString('title') ?? 'New Conversation'

  await interaction.reply(
    `To start a new conversation, create a new thread titled "${title}". ` +
      `The bot will automatically join and respond to messages in the thread.`,
  )
}

async function handleReset(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: 'Session reset is not yet supported. The orchestrator does not expose a session delete endpoint yet.',
    ephemeral: true,
  })
}
