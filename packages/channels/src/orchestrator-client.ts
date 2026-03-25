import type { ChannelMessage, OrchestratorResponse } from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000

export class OrchestratorClient {
  private baseUrl: string
  private timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  async sendMessage(message: ChannelMessage): Promise<OrchestratorResponse> {
    const url = `${this.baseUrl}/api/message`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const err = error as Error
      throw new Error(
        `Orchestrator request to ${url} failed: ${err.message}`,
        { cause: err },
      )
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Orchestrator responded with ${response.status} ${response.statusText}: ${body}`,
      )
    }

    return response.json() as Promise<OrchestratorResponse>
  }
}
