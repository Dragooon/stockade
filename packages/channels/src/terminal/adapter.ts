import * as readline from 'node:readline'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type { ChannelAdapter, ChannelMessage } from '../types.js'
import { OrchestratorClient } from '../orchestrator-client.js'
import { buildScope } from '../scope.js'

export class TerminalAdapter implements ChannelAdapter {
  name = 'terminal'

  private client: OrchestratorClient
  private scope: string
  private userId: string
  private rl: readline.Interface | null = null

  constructor(config: { orchestratorUrl: string; agent: string }) {
    this.client = new OrchestratorClient(config.orchestratorUrl)
    this.userId = os.userInfo().username
    const sessionId = crypto.randomUUID()
    this.scope = buildScope(['terminal', 'local', sessionId, this.userId])
  }

  buildMessage(content: string): ChannelMessage {
    return {
      scope: this.scope,
      content,
      userId: this.userId,
      platform: 'terminal',
    }
  }

  async handleInput(input: string): Promise<string> {
    const message = this.buildMessage(input)
    const result = await this.client.sendMessage(message)
    return result.response
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const prompt = () => {
      this.rl!.question('> ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed) {
          prompt()
          return
        }

        process.stdout.write('Thinking...\n')

        try {
          const response = await this.handleInput(trimmed)
          process.stdout.write(`\n${response}\n\n`)
        } catch (err) {
          const error = err as Error
          process.stdout.write(`\nError: ${error.message}\n\n`)
        }

        prompt()
      })
    }

    prompt()

    this.rl.on('close', () => {
      process.stdout.write('\nGoodbye!\n')
    })
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
  }
}
