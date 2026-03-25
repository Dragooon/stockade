import type { RunRequest, RunResponse } from '@/types';

export interface SendOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Send a request to an agent's /run endpoint */
export async function sendToAgent(
  agentUrl: string,
  request: RunRequest,
  options?: SendOptions,
): Promise<RunResponse> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${agentUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Agent at ${agentUrl} returned status ${response.status}: ${body}`,
      );
    }

    const data: RunResponse = await response.json();
    return data;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `Agent request to ${agentUrl} timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
