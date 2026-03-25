import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import type { CoreTool } from 'ai';

export const ALL_TOOLS: Record<string, CoreTool> = {
  bash: bashTool,
  'file-read': fileReadTool,
  'file-write': fileWriteTool,
  'file-edit': fileEditTool,
};

export function getTools(names: string[]): Record<string, CoreTool> {
  const result: Record<string, CoreTool> = {};
  for (const name of names) {
    const tool = ALL_TOOLS[name];
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    result[name] = tool;
  }
  return result;
}
