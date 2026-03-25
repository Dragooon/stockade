import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/server.js';
import { AgentRunner } from '../src/runner.js';
import type { AgentConfig } from '../src/types.js';
import type { LanguageModelV1 } from 'ai';

function createMockModel(responseText: string): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: undefined,
    doGenerate: async ({ prompt }) => ({
      text: responseText,
      finishReason: 'stop' as const,
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: prompt, rawSettings: {} },
    }),
    doStream: async ({ prompt }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: 'text-delta' as const,
            textDelta: responseText,
          });
          controller.enqueue({
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: { promptTokens: 10, completionTokens: 5 },
          });
          controller.close();
        },
      }),
      rawCall: { rawPrompt: prompt, rawSettings: {} },
    }),
  };
}

describe('HTTP server', () => {
  const config: AgentConfig = {
    agentId: 'test-agent',
    port: 0,
    model: 'test-model',
    provider: 'test',
    tools: ['bash'],
    maxSteps: 5,
    compactionThreshold: 100000,
  };

  const mockModel = createMockModel('Hello from test!');
  const runner = new AgentRunner(config, mockModel);
  const app = createApp(runner, config);

  it('GET /health should return ok and agentId', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe('test-agent');
  });

  it('GET /tools should return tool definitions', async () => {
    const res = await app.request('/tools');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0].name).toBe('bash');
  });

  it('POST /run should execute and return response', async () => {
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'You are a test agent.',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toBeDefined();
    expect(body.finishReason).toBe('stop');
    expect(body.usage).toBeDefined();
  });

  it('POST /run should return 400 for invalid request', async () => {
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /run/stream should return SSE response', async () => {
    const res = await app.request('/run/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'You are a test agent.',
      }),
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('text');
  });
});
