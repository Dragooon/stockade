import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendToAgent } from '@/lib/agent-client';
import type { RunRequest, RunResponse } from '@/types';
import { createServer, Server } from 'http';

describe('Agent Client', () => {
  let server: Server;
  let serverPort: number;

  function startMockServer(
    statusCode: number,
    responseBody: object | string,
    delay = 0,
  ): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
        }, delay);
      });
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(port);
      });
    });
  }

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it('sends a request and receives a successful response', async () => {
    const mockResponse: RunResponse = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      usage: { totalTokens: 100 },
      finishReason: 'stop',
    };

    serverPort = await startMockServer(200, mockResponse);
    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      systemPrompt: 'You are helpful.',
    };

    const result = await sendToAgent(`http://localhost:${serverPort}`, request);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].content).toBe('Hi there!');
    expect(result.finishReason).toBe('stop');
  });

  it('throws on non-200 status', async () => {
    serverPort = await startMockServer(500, { error: 'Internal Server Error' });
    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      systemPrompt: 'You are helpful.',
    };

    await expect(sendToAgent(`http://localhost:${serverPort}`, request)).rejects.toThrow(
      /500/,
    );
  });

  it('throws on timeout', async () => {
    serverPort = await startMockServer(200, { messages: [] }, 5000);
    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      systemPrompt: 'You are helpful.',
    };

    await expect(
      sendToAgent(`http://localhost:${serverPort}`, request, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out|timeout|abort/i);
  });

  it('throws with connection error', async () => {
    const request: RunRequest = {
      messages: [{ role: 'user', content: 'Hello' }],
      systemPrompt: 'You are helpful.',
    };

    await expect(
      sendToAgent('http://localhost:1', request),
    ).rejects.toThrow();
  });
});
