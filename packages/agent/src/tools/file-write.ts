import { tool } from 'ai';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const fileWriteTool = tool({
  description: 'Write content to a file, creating directories if needed',
  parameters: z.object({
    path: z.string().describe('Absolute file path'),
    content: z.string().describe('File content to write'),
  }),
  execute: async ({ path, content }) => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf-8');
      return { success: true, path };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  },
});
