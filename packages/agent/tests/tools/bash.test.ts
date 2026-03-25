import { describe, it, expect } from 'vitest';
import { bashTool } from '../../src/tools/bash.js';

describe('bash tool', () => {
  it('should have correct description', () => {
    expect(bashTool.description).toBe('Execute a shell command');
  });

  it('should execute a simple command and return stdout', async () => {
    const result = await bashTool.execute(
      { command: 'echo hello world', timeout: 5000 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  it('should return stderr on error', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "console.error(\'oops\'); process.exit(1)"', timeout: 5000 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.stderr).toContain('oops');
    expect(result.exitCode).toBe(1);
  });

  it('should respect working directory', async () => {
    const result = await bashTool.execute(
      { command: 'pwd', timeout: 5000, workingDir: '/' },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.stdout.trim()).toMatch(/^\/|^[A-Z]:\//i);
    expect(result.exitCode).toBe(0);
  });

  it('should handle timeout', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "setTimeout(()=>{},60000)"', timeout: 500 },
      { toolCallId: 'test', messages: [], abortSignal: undefined as any },
    );
    expect(result.error).toBeDefined();
  });
});
