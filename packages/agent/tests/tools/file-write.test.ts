import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileWriteTool } from '../../src/tools/file-write.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('file-write tool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-write-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should have correct description', () => {
    expect(fileWriteTool.description).toBe('Write content to a file, creating directories if needed');
  });

  it('should write content to a file', async () => {
    const filePath = join(tempDir, 'output.txt');
    const result = await fileWriteTool.execute(
      { path: filePath, content: 'hello world' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('should create parent directories if needed', async () => {
    const filePath = join(tempDir, 'deep', 'nested', 'dir', 'file.txt');
    const result = await fileWriteTool.execute(
      { path: filePath, content: 'nested content' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('nested content');
  });

  it('should overwrite existing file', async () => {
    const filePath = join(tempDir, 'existing.txt');
    await fileWriteTool.execute(
      { path: filePath, content: 'original' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    await fileWriteTool.execute(
      { path: filePath, content: 'updated' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('updated');
  });
});
