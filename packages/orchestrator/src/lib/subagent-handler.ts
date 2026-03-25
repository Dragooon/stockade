import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import type { AgentsConfig, PlatformConfig, AgentConfig, SubAgentRequest } from '@/types';
import { checkAccess } from '@/lib/rbac';
import { parseScope } from '@/lib/router';

export interface SubAgentHandlerDeps {
  agentsConfig: AgentsConfig;
  platformConfig: PlatformConfig;
  db: BetterSQLite3Database<typeof schema>;
  spawnEphemeral: (agentId: string, config: AgentConfig, task: string) => Promise<string>;
}

export interface SubAgentResult {
  result: string;
}

/** Core sub-agent handling logic */
export async function handleSubAgent(
  request: SubAgentRequest,
  deps: SubAgentHandlerDeps,
): Promise<SubAgentResult> {
  // 1. Find parent session to determine user identity
  const parentSession = deps.db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, request.parentSessionId))
    .get();

  if (!parentSession) {
    throw new Error('Parent session not found');
  }

  // 2. Parse scope to get user identity
  const parsed = parseScope(parentSession.scope);
  const userId = parsed.user ?? '';
  const platform = parsed.platform;

  // 3. RBAC check: does the parent session's user have access to the sub-agent?
  if (!checkAccess(userId, platform, request.agentId, deps.platformConfig)) {
    throw new Error('Unauthorized: user does not have access to this sub-agent');
  }

  // 4. Get agent config
  const agentConfig = deps.agentsConfig.agents[request.agentId];
  if (!agentConfig) {
    throw new Error(`Agent "${request.agentId}" not found in agents config`);
  }

  // 5. Build task with optional context
  const taskWithContext = request.context
    ? `Context: ${request.context}\n\nTask: ${request.task}`
    : request.task;

  // 6. Spawn ephemeral agent
  const result = await deps.spawnEphemeral(request.agentId, agentConfig, taskWithContext);

  return { result };
}
