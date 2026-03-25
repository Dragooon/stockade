export interface ChannelMessage {
  scope: string
  content: string
  userId: string
  platform: string
  metadata?: Record<string, unknown>
}

export interface ChannelAdapter {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
}

export interface OrchestratorResponse {
  response: string
  sessionId: string
}

export interface ChannelStartupConfig {
  orchestratorUrl: string
  terminal?: {
    enabled: boolean
    agent: string
  }
  discord?: {
    enabled: boolean
    token: string
    bindings: Array<{
      server: string
      agent: string
      channels: string | string[]
    }>
  }
}
