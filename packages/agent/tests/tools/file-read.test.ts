import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileReadTool } from '../../src/tools/file-read.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('file-read tool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-read-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should have correct description', () => {
    expect(fileReadTool.description).toBe('Read a file, optionally with offset and line limit');
  });

  it('should read a file with line numbers', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'line one\nline two\nline three\n');
    const result = await fileReadTool.execute(
      { path: filePath },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.content).toContain('1\tline one');
    expect(result.content).toContain('2\tline two');
    expect(result.content).toContain('3\tline three');
  });

  it('should apply offset (1-based)', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'line one\nline two\nline three\nline four\n');
    const result = await fileReadTool.execute(
      { path: filePath, offset: 2 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.content).not.toContain('1\tline one');
    expect(result.content).toContain('2\tline two');
    expect(result.content).toContain('3\tline three');
  });

  it('should apply limit', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'line one\nline two\nline three\nline four\n');
    const result = await fileReadTool.execute(
      { path: filePath, limit: 2 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.content).toContain('1\tline one');
    expect(result.content).toContain('2\tline two');
    expect(result.content).not.toContain('3\tline three');
  });

  it('should apply offset and limit together', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'a\nb\nc\nd\ne\n');
    const result = await fileReadTool.execute(
      { path: filePath, offset: 2, limit: 2 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.content).not.toContain('1\ta');
    expect(result.content).toContain('2\tb');
    expect(result.content).toContain('3\tc');
    expect(result.content).not.toContain('4\td');
  });

  it('should return error for non-existent file', async () => {
    const result = await fileReadTool.execute(
      { path: join(tempDir, 'nonexistent.txt') },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.error).toBeDefined();
  });
});
