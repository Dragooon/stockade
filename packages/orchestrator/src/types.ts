/** Incoming message from a channel adapter */
export interface ChannelMessage {
  scope: string;
  content: string;
  userId: string;
  platform: string;
  metadata?: Record<string, unknown>;
}

/** Session record as stored in the database */
export interface SessionRecord {
  id: string;
  scope: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

/** Message record as stored in the database */
export interface MessageRecord {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
}

/** Core message format (compatible with Vercel AI SDK) */
export interface CoreMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
}

/** MCP server configuration */
export interface MCPServerConfig {
  name: string;
  url: string;
}

/** Single agent configuration from agents.yaml */
export interface AgentConfig {
  model: string;
  provider: string;
  system: string;
  tools: string[];
  mcp?: MCPServerConfig[];
  sandbox: boolean;
  lifecycle: 'persistent' | 'ephemeral';
  port?: number;
  memory?: { dir: string };
  docker?: {
    image: string;
    network?: string;
  };
}

/** Full agents.yaml config */
export interface AgentsConfig {
  agents: Record<string, AgentConfig>;
}

/** Channel binding for discord */
export interface ChannelBinding {
  server: string;
  agent: string;
  channels: string | string[];
}

/** Full platform.yaml config */
export interface PlatformConfig {
  channels: {
    terminal?: { enabled: boolean; agent: string };
    discord?: {
      enabled: boolean;
      token: string;
      bindings: ChannelBinding[];
    };
  };
  rbac: {
    roles: Record<string, {
      permissions: string[];
    }>;
    users: Record<string, {
      roles: string[];
      identities: Record<string, string>;
    }>;
  };
}

/** Request to agent /run endpoint */
export interface RunRequest {
  messages: CoreMessage[];
  systemPrompt: string;
  config?: {
    model?: string;
    maxSteps?: number;
  };
}

/** Response from agent /run endpoint */
export interface RunResponse {
  messages: CoreMessage[];
  usage: Record<string, unknown>;
  finishReason: string;
}

/** Handle for a running agent process */
export interface AgentHandle {
  process: unknown; // ChildProcess or Container
  port: number;
  url: string;
}

/** Sub-agent request */
export interface SubAgentRequest {
  parentSessionId: string;
  agentId: string;
  task: string;
  context?: string;
}
