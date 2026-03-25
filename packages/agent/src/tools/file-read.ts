import { tool } from 'ai';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

export const fileReadTool = tool({
  description: 'Read a file, optionally with offset and line limit',
  parameters: z.object({
    path: z.string().describe('Absolute file path'),
    offset: z.number().optional().describe('Line number to start from (1-based)'),
    limit: z.number().optional().describe('Max lines to read'),
  }),
  execute: async ({ path, offset, limit }) => {
    try {
      const raw = await readFile(path, 'utf-8');
      let lines = raw.split('\n');

      // Remove trailing empty line from final newline
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines = lines.slice(0, -1);
      }

      const startIndex = offset ? offset - 1 : 0;
      const endIndex = limit ? startIndex + limit : lines.length;

      const numbered = lines
        .slice(startIndex, endIndex)
        .map((line, i) => `${startIndex + i + 1}\t${line}`)
        .join('\n');

      return { content: numbered };
    } catch (err: unknown) {
      return { error: (err as Error).message };
    }
  },
});
