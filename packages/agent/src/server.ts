import { Hono } from 'hono';
import type { AgentRunner } from './runner.js';
import type { AgentConfig, RunRequest } from './types.js';

export function createApp(runner: AgentRunner, config: AgentConfig) {
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({ ok: true, agentId: config.agentId });
  });

  app.get('/tools', (c) => {
    return c.json({ tools: runner.getToolDefinitions() });
  });

  app.post('/run', async (c) => {
    try {
      const body = await c.req.json();

      if (!body.messages || !body.systemPrompt) {
        return c.json({ error: 'messages and systemPrompt are required' }, 400);
      }

      const request: RunRequest = {
        messages: body.messages,
        systemPrompt: body.systemPrompt,
        config: body.config,
      };

      const response = await runner.run(request);
      return c.json(response);
    } catch (err: unknown) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/run/stream', async (c) => {
    try {
      const body = await c.req.json();

      if (!body.messages || !body.systemPrompt) {
        return c.json({ error: 'messages and systemPrompt are required' }, 400);
      }

      const request: RunRequest = {
        messages: body.messages,
        systemPrompt: body.systemPrompt,
        config: body.config,
      };

      const stream = await runner.stream(request);
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } catch (err: unknown) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}
