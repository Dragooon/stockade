import { describe, it, expect } from 'vitest';
import { getTools, ALL_TOOLS } from '../../src/tools/index.js';

describe('tool registry', () => {
  it('should export ALL_TOOLS with all built-in tools', () => {
    expect(ALL_TOOLS).toHaveProperty('bash');
    expect(ALL_TOOLS).toHaveProperty('file-read');
    expect(ALL_TOOLS).toHaveProperty('file-write');
    expect(ALL_TOOLS).toHaveProperty('file-edit');
  });

  it('should return filtered tools by name', () => {
    const tools = getTools(['bash', 'file-read']);
    expect(Object.keys(tools)).toEqual(['bash', 'file-read']);
    expect(tools.bash).toBeDefined();
    expect(tools['file-read']).toBeDefined();
  });

  it('should return all tools when all names given', () => {
    const tools = getTools(['bash', 'file-read', 'file-write', 'file-edit']);
    expect(Object.keys(tools)).toHaveLength(4);
  });

  it('should throw for unknown tool name', () => {
    expect(() => getTools(['bash', 'unknown-tool'])).toThrow('unknown-tool');
  });

  it('should return empty object for empty array', () => {
    const tools = getTools([]);
    expect(Object.keys(tools)).toHaveLength(0);
  });
});
