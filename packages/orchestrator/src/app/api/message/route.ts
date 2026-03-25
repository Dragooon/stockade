import { NextResponse } from 'next/server';
import { handleMessage } from '@/lib/message-handler';
import { loadConfig } from '@/lib/config';
import { getDb } from '@/lib/db';
import { AgentManager } from '@/lib/agents';
import type { ChannelMessage } from '@/types';
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
    const body: ChannelMessage = await request.json();

    if (!body.scope || !body.content || !body.userId || !body.platform) {
      return NextResponse.json(
        { error: 'Missing required fields: scope, content, userId, platform' },
        { status: 400 },
      );
    }

    const { agents, platform } = getConfig();
    const db = getDb();

    const result = await handleMessage(body, {
      agentsConfig: agents,
      platformConfig: platform,
      db,
      getAgentUrl: (agentId) => agentManager.getAgentUrl(agentId),
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.toLowerCase().includes('unauthorized')) {
      return NextResponse.json({ error: message }, { status: 403 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
