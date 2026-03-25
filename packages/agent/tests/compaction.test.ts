import { describe, it, expect } from 'vitest';
import { estimateTokens, shouldCompact, compact } from '../src/compaction.js';
import type { CoreMessage } from 'ai';

describe('compaction', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens as chars / 4', () => {
      const messages: CoreMessage[] = [
        { role: 'user', content: 'abcd' }, // 4 chars => 1 token
        { role: 'assistant', content: 'efghijkl' }, // 8 chars => 2 tokens
      ];
      // Total chars in content = 12, so ~3 tokens
      const tokens = estimateTokens(messages);
      expect(tokens).toBe(3);
    });

    it('should handle empty messages', () => {
      expect(estimateTokens([])).toBe(0);
    });

    it('should handle messages with array content parts', () => {
      const messages: CoreMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello world' }],
        },
      ];
      const tokens = estimateTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('shouldCompact', () => {
    it('should return true when tokens exceed threshold', () => {
      const messages: CoreMessage[] = [
        { role: 'user', content: 'x'.repeat(400) }, // 100 tokens
      ];
      expect(shouldCompact(messages, 50)).toBe(true);
    });

    it('should return false when tokens are under threshold', () => {
      const messages: CoreMessage[] = [
        { role: 'user', content: 'short' },
      ];
      expect(shouldCompact(messages, 1000)).toBe(false);
    });
  });

  describe('compact', () => {
    it('should keep recent messages and summarize older ones', async () => {
      const messages: CoreMessage[] = [];
      // Create 30 messages
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'user', content: `Message ${i}` });
        messages.push({ role: 'assistant', content: `Response ${i}` });
      }

      // Use a mock model that returns a summary
      const mockModel = {
        doGenerate: async () => ({
          text: 'Summary of previous conversation',
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        }),
        specificationVersion: 'v1' as const,
        provider: 'test',
        modelId: 'test-model',
        defaultObjectGenerationMode: undefined,
      };

      const result = await compact(messages, mockModel as any);

      // Should have a system summary message + recent messages
      expect(result.length).toBeLessThan(messages.length);
      expect(result[0].role).toBe('system');
      // The first message should contain the summary with 'Summary: ' prefix
      const firstContent = typeof result[0].content === 'string'
        ? result[0].content
        : '';
      expect(firstContent).toMatch(/^Summary: /);
    });
  });
});
