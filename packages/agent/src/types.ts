import type { CoreMessage } from 'ai';

export type { CoreMessage };

export interface RunRequest {
  messages: CoreMessage[];
  systemPrompt: string;
  config?: {
    model?: string;
    maxSteps?: number;
  };
}

export interface RunResponse {
  messages: CoreMessage[];
  usage: Record<string, unknown>;
  finishReason: string;
}

export interface AgentConfig {
  agentId: string;
  port: number;
  model: string;
  provider: string;
  tools: string[];
  maxSteps: number;
  memoryDir?: string;
  compactionThreshold: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
