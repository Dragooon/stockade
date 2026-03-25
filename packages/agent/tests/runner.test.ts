import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../src/runner.js';
import type { AgentConfig, RunRequest } from '../src/types.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV1 } from 'ai';
import * as compactionModule from '../src/compaction.js';

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

describe('AgentRunner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'runner-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
    return {
      agentId: 'test-agent',
      port: 3000,
      model: 'test-model',
      provider: 'test',
      tools: [],
      maxSteps: 5,
      compactionThreshold: 100000,
      ...overrides,
    };
  }

  it('should construct with a config', () => {
    const config = makeConfig();
    const runner = new AgentRunner(config, createMockModel('hello'));
    expect(runner).toBeDefined();
  });

  it('should run a basic conversation and return response', async () => {
    const config = makeConfig();
    const runner = new AgentRunner(config, createMockModel('Hello from the agent!'));

    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Hi there' }],
      systemPrompt: 'You are a test agent.',
    };

    const response = await runner.run(request);
    expect(response.messages).toBeDefined();
    expect(response.messages.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toBeDefined();
  });

  it('should inject memory into system prompt', async () => {
    await writeFile(join(tempDir, 'test.md'), 'Memory content here');

    const config = makeConfig({ memoryDir: tempDir });

    let capturedPrompt: unknown = null;
    const mockModel: LanguageModelV1 = {
      specificationVersion: 'v1',
      provider: 'test',
      modelId: 'test-model',
      defaultObjectGenerationMode: undefined,
      doGenerate: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          text: 'ok',
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: prompt, rawSettings: {} },
        };
      },
      doStream: async () => { throw new Error('not used'); },
    };

    const runner = new AgentRunner(config, mockModel);

    const request: RunRequest = {
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'Base prompt.',
    };

    await runner.run(request);

    // Verify the prompt included memory content
    const promptStr = JSON.stringify(capturedPrompt);
    expect(promptStr).toContain('Memory content here');
  });

  it('should provide tool definitions', () => {
    const config = makeConfig({ tools: ['bash', 'file-read'] });
    const runner = new AgentRunner(config, createMockModel('ok'));
    const defs = runner.getToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toContain('bash');
    expect(defs.map((d) => d.name)).toContain('file-read');
  });

  it('should handle config override in request', async () => {
    const config = makeConfig({ maxSteps: 1 });
    const runner = new AgentRunner(config, createMockModel('ok'));

    const request: RunRequest = {
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'Test.',
      config: { maxSteps: 3 },
    };

    const response = await runner.run(request);
    expect(response.messages).toBeDefined();
  });

  it('should verify tool calls flow — tool is invoked and result flows back', async () => {
    let callCount = 0;

    // Mock model that returns a tool call on the first step, then text on the second
    const mockModel: LanguageModelV1 = {
      specificationVersion: 'v1',
      provider: 'test',
      modelId: 'test-model',
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: return a tool call to bash
          return {
            text: '',
            toolCalls: [
              {
                toolCallType: 'function' as const,
                toolCallId: 'call-1',
                toolName: 'bash',
                args: JSON.stringify({ command: 'echo hello-from-tool' }),
              },
            ],
            finishReason: 'tool-calls' as const,
            usage: { promptTokens: 10, completionTokens: 5 },
            rawCall: { rawPrompt: '', rawSettings: {} },
          };
        }
        // Second call: return a text response after tool result is in context
        return {
          text: 'Tool executed successfully',
          finishReason: 'stop' as const,
          usage: { promptTokens: 20, completionTokens: 10 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        };
      },
      doStream: async () => { throw new Error('not used'); },
    };

    const config = makeConfig({ tools: ['bash'], maxSteps: 5 });
    const runner = new AgentRunner(config, mockModel);

    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Run echo hello-from-tool' }],
      systemPrompt: 'You are a test agent.',
    };

    const response = await runner.run(request);

    // Model was called twice: once for tool call, once for final text
    expect(callCount).toBe(2);

    // Response messages should contain the assistant tool-call, the tool result, and the final text
    expect(response.messages.length).toBeGreaterThanOrEqual(3);

    // Find the tool result message
    const toolResultMsg = response.messages.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();

    // The tool result content should contain the bash output
    const toolContent = JSON.stringify(toolResultMsg!.content);
    expect(toolContent).toContain('hello-from-tool');

    // Final finish reason should be 'stop'
    expect(response.finishReason).toBe('stop');
  });

  it('should trigger compaction when token threshold is exceeded', async () => {
    // Spy on the compact function
    const compactSpy = vi.spyOn(compactionModule, 'compact');

    // Mock model that returns a summary when asked to compact, and normal responses otherwise
    const mockModel: LanguageModelV1 = {
      specificationVersion: 'v1',
      provider: 'test',
      modelId: 'test-model',
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        text: 'ok',
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 5 },
        rawCall: { rawPrompt: '', rawSettings: {} },
      }),
      doStream: async () => { throw new Error('not used'); },
    };

    // Very low compaction threshold (100 tokens = ~400 chars) to trigger compaction
    const config = makeConfig({ compactionThreshold: 100 });
    const runner = new AgentRunner(config, mockModel);

    // Build messages with enough content to exceed the threshold
    // Each message needs ~400 chars total to exceed 100 tokens (chars/4)
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `Message ${i}: ${'x'.repeat(50)}` });
      messages.push({ role: 'assistant', content: `Response ${i}: ${'y'.repeat(50)}` });
    }

    const request: RunRequest = {
      messages,
      systemPrompt: 'Test compaction.',
    };

    await runner.run(request);

    // Verify compact was called because the messages exceeded the threshold
    expect(compactSpy).toHaveBeenCalled();

    compactSpy.mockRestore();
  });
});
