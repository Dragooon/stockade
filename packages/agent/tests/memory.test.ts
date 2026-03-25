import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadMemory } from '../src/memory.js';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('memory loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'memory-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return empty string for non-existent directory', async () => {
    const result = await loadMemory(join(tempDir, 'nonexistent'));
    expect(result).toBe('');
  });

  it('should return empty string for empty directory', async () => {
    const emptyDir = join(tempDir, 'empty');
    await mkdir(emptyDir);
    const result = await loadMemory(emptyDir);
    expect(result).toBe('');
  });

  it('should load a single markdown file', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Some important notes');
    const result = await loadMemory(tempDir);
    expect(result).toContain('## Memory');
    expect(result).toContain('### notes.md');
    expect(result).toContain('Some important notes');
  });

  it('should load multiple markdown files', async () => {
    await writeFile(join(tempDir, 'first.md'), 'First content');
    await writeFile(join(tempDir, 'second.md'), 'Second content');
    const result = await loadMemory(tempDir);
    expect(result).toContain('### first.md');
    expect(result).toContain('First content');
    expect(result).toContain('### second.md');
    expect(result).toContain('Second content');
  });

  it('should only load .md files', async () => {
    await writeFile(join(tempDir, 'notes.md'), 'Markdown content');
    await writeFile(join(tempDir, 'data.json'), '{"key": "value"}');
    await writeFile(join(tempDir, 'script.ts'), 'console.log("hi")');
    const result = await loadMemory(tempDir);
    expect(result).toContain('notes.md');
    expect(result).not.toContain('data.json');
    expect(result).not.toContain('script.ts');
  });

  it('should wrap content in code blocks', async () => {
    await writeFile(join(tempDir, 'test.md'), 'Content here');
    const result = await loadMemory(tempDir);
    expect(result).toContain('```\nContent here\n```');
  });
});
