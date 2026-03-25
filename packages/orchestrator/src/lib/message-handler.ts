import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { ChannelMessage, AgentsConfig, PlatformConfig } from '@/types';
import { resolveAgent } from '@/lib/router';
import { checkAccess } from '@/lib/rbac';
import { getOrCreateSession, getMessages, saveMessages } from '@/lib/sessions';
import { sendToAgent } from '@/lib/agent-client';

export interface MessageHandlerDeps {
  agentsConfig: AgentsConfig;
  platformConfig: PlatformConfig;
  db: BetterSQLite3Database<typeof schema>;
  getAgentUrl: (agentId: string) => string | undefined;
}

export interface MessageResult {
  response: string;
  sessionId: string;
}

/** Core message handling logic — extracted from the route for testability */
export async function handleMessage(
  msg: ChannelMessage,
  deps: MessageHandlerDeps,
): Promise<MessageResult> {
  // 1. Resolve agent from scope
  const agentId = resolveAgent(msg.scope, deps.platformConfig);

  // 2. RBAC check
  if (!checkAccess(msg.userId, msg.platform, agentId, deps.platformConfig)) {
    throw new Error('Unauthorized: user does not have access to this agent');
  }

  // 3. Session management
  const session = getOrCreateSession(deps.db, msg.scope, agentId);
  const existingMessages = getMessages(deps.db, session.id);

  // 4. Build request for agent
  const messages = [...existingMessages, { role: 'user' as const, content: msg.content }];

  // 5. Get agent URL
  const agentUrl = deps.getAgentUrl(agentId);
  if (!agentUrl) {
    throw new Error(`Agent "${agentId}" is not running or not available`);
  }

  // 6. Get agent config
  const agentConfig = deps.agentsConfig.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent "${agentId}" not found in agents config`);
  }

  // 7. Call agent
  const result = await sendToAgent(agentUrl, {
    messages,
    systemPrompt: agentConfig.system,
  });

  // 8. Persist messages
  saveMessages(deps.db, session.id, result.messages);

  // 9. Extract assistant response
  const lastAssistant = result.messages.findLast((m) => m.role === 'assistant');

  return {
    response: lastAssistant?.content ?? '',
    sessionId: session.id,
  };
}
