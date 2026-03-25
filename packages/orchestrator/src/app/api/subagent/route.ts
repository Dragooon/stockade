import { NextResponse } from 'next/server';
import { handleSubAgent } from '@/lib/subagent-handler';
import { loadConfig } from '@/lib/config';
import { getDb } from '@/lib/db';
import { AgentManager } from '@/lib/agents';
import type { SubAgentRequest } from '@/types';
import path from 'path';

const configDir = path.resolve(process.cwd(), '../../config');
let config: ReturnType<typeof loadConfig> | null = null;
const agentManager = new AgentManager();

function getConfig() {
  if (!config) {
    config = loadConfig(configDir);
  }
  return config;
}

export async function POST(request: Request) {
  try {
    const body: SubAgentRequest = await request.json();

    if (!body.parentSessionId || !body.agentId || !body.task) {
      return NextResponse.json(
        { error: 'Missing required fields: parentSessionId, agentId, task' },
        { status: 400 },
      );
    }

    const { agents, platform } = getConfig();
    const db = getDb();

    const result = await handleSubAgent(body, {
      agentsConfig: agents,
      platformConfig: platform,
      db,
      spawnEphemeral: (agentId, agentConfig, task) =>
        agentManager.spawnEphemeral(agentId, agentConfig, task),
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.toLowerCase().includes('unauthorized')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    if (message.toLowerCase().includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
