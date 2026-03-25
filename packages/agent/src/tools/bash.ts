import { tool } from 'ai';
import { z } from 'zod';
import { execaCommand } from 'execa';

export const bashTool = tool({
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().default(30000).describe('Timeout in ms'),
    workingDir: z.string().optional().describe('Working directory'),
  }),
  execute: async ({ command, timeout, workingDir }) => {
    try {
      type ExecResult = {
        timedOut: false;
        stdout: string;
        stderr: string;
        exitCode: number;
        failed: boolean;
        errorMessage?: string;
      };

      const subprocess = execaCommand(command, {
        shell: true,
        cwd: workingDir,
      });

      const execPromise = subprocess.then(
        (r) => ({
          timedOut: false as const,
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          failed: false,
        } as ExecResult),
        (e) => ({
          timedOut: false as const,
          stdout: (e.stdout ?? '') as string,
          stderr: (e.stderr ?? '') as string,
          exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
          failed: true,
          errorMessage: e.message as string,
        } as ExecResult),
      );

      const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), timeout);
      });

      const raceResult = await Promise.race([execPromise, timeoutPromise]);

      if (raceResult.timedOut) {
        subprocess.kill('SIGTERM');
        setTimeout(() => {
          try { subprocess.kill('SIGKILL'); } catch {}
        }, 500);
        return {
          stdout: '',
          stderr: '',
          exitCode: 1,
          error: `Command timed out after ${timeout}ms`,
        };
      }

      const result = raceResult as ExecResult;
      if (result.failed) {
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          error: result.errorMessage ?? 'Command failed',
        };
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (err: unknown) {
      return {
        stdout: '',
        stderr: '',
        exitCode: 1,
        error: (err as Error).message ?? 'Command failed',
      };
    }
  },
});
