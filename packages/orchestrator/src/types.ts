/** Agent configuration from agents.yaml */
export interface AgentConfig {
  model: string;
  system: string;
  tools: string[];
  lifecycle: "persistent" | "ephemeral";
  remote: boolean;
  port?: number;
  url?: string;
  subagents?: string[];
}

/** Top-level agents.yaml shape */
export interface AgentsConfig {
  agents: Record<string, AgentConfig>;
}

/** A single channel binding in platform.yaml */
export interface ChannelBinding {
  server: string;
  agent: string;
  channels: string | string[];
}

/** Platform configuration from platform.yaml */
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
    roles: Record<string, { permissions: string[] }>;
    users: Record<
      string,
      {
        roles: string[];
        identities: Record<string, string>;
      }
    >;
  };
}

/** Unified message from any channel */
export interface ChannelMessage {
  scope: string;
  content: string;
  userId: string;
  platform: string;
}

/** Result returned from dispatching to an agent */
export interface DispatchResult {
  result: string;
  sessionId: string;
}

/** Resolved user info from RBAC */
export interface ResolvedUser {
  username: string;
  roles: string[];
  permissions: string[];
}
