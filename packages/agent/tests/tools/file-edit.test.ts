import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileEditTool } from '../../src/tools/file-edit.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('file-edit tool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'file-edit-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should have correct description', () => {
    expect(fileEditTool.description).toBe('Find and replace text in a file');
  });

  it('should replace a unique string', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'hello world\nfoo bar\nbaz qux\n');
    const result = await fileEditTool.execute(
      { path: filePath, oldString: 'foo bar', newString: 'replaced', replaceAll: false },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hello world\nreplaced\nbaz qux\n');
  });

  it('should fail if oldString is not found', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'hello world\n');
    const result = await fileEditTool.execute(
      { path: filePath, oldString: 'nonexistent', newString: 'replaced', replaceAll: false },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should fail if oldString is not unique when replaceAll is false', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'hello hello\n');
    const result = await fileEditTool.execute(
      { path: filePath, oldString: 'hello', newString: 'bye', replaceAll: false },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not unique');
  });

  it('should replace all occurrences when replaceAll is true', async () => {
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'aaa bbb aaa ccc aaa\n');
    const result = await fileEditTool.execute(
      { path: filePath, oldString: 'aaa', newString: 'xxx', replaceAll: true },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(true);
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('xxx bbb xxx ccc xxx\n');
  });

  it('should return error for non-existent file', async () => {
    const result = await fileEditTool.execute(
      { path: join(tempDir, 'nonexistent.txt'), oldString: 'a', newString: 'b', replaceAll: false },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
