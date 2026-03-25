import { tool } from 'ai';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';

export const fileEditTool = tool({
  description: 'Find and replace text in a file',
  parameters: z.object({
    path: z.string().describe('Absolute file path'),
    oldString: z.string().describe('Text to find'),
    newString: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().default(false),
  }),
  execute: async ({ path, oldString, newString, replaceAll }) => {
    try {
      const content = await readFile(path, 'utf-8');

      if (!content.includes(oldString)) {
        return { success: false, error: `oldString not found in file: ${path}` };
      }

      if (!replaceAll) {
        const firstIndex = content.indexOf(oldString);
        const secondIndex = content.indexOf(oldString, firstIndex + 1);
        if (secondIndex !== -1) {
          return {
            success: false,
            error: `oldString is not unique in file (found multiple occurrences). Use replaceAll: true to replace all.`,
          };
        }
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await writeFile(path, updated, 'utf-8');
      return { success: true, path };
    } catch (err: unknown) {
      return { success: false, error: (err as Error).message };
    }
  },
});
