import { serve } from '@hono/node-server';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createApp } from './server.js';
import { AgentRunner } from './runner.js';
import type { AgentConfig } from './types.js';

const config: AgentConfig = {
  agentId: process.env.AGENT_ID ?? 'default-agent',
  port: parseInt(process.env.PORT ?? '3100', 10),
  model: process.env.MODEL ?? 'claude-sonnet-4-20250514',
  provider: process.env.PROVIDER ?? 'anthropic',
  tools: (process.env.TOOLS ?? 'bash,file-read,file-write,file-edit').split(',').filter(Boolean),
  maxSteps: parseInt(process.env.MAX_STEPS ?? '20', 10),
  memoryDir: process.env.MEMORY_DIR,
  compactionThreshold: parseInt(process.env.COMPACTION_THRESHOLD ?? '100000', 10),
};

const anthropic = createAnthropic();
const model = anthropic(config.model);
const runner = new AgentRunner(config, model);
const app = createApp(runner, config);

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`Agent "${config.agentId}" listening on http://localhost:${info.port}`);
  },
);
