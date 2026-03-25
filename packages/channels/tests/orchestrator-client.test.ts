import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrchestratorClient } from '../src/orchestrator-client.js'
import type { ChannelMessage } from '../src/types.js'

const BASE_URL = 'http://localhost:3000'

const sampleMessage: ChannelMessage = {
  scope: 'terminal:local:session-1:alice',
  content: 'Hello agent',
  userId: 'alice',
  platform: 'terminal',
}

describe('OrchestratorClient', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends POST to /api/message with correct body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Hi there!', sessionId: 'sess-1' }),
    })

    const client = new OrchestratorClient(BASE_URL)
    const result = await client.sendMessage(sampleMessage)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/message`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleMessage),
      }),
    )
    expect(result).toEqual({ response: 'Hi there!', sessionId: 'sess-1' })
  })

  it('throws on 403 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Access denied',
    })

    const client = new OrchestratorClient(BASE_URL)
    await expect(client.sendMessage(sampleMessage)).rejects.toThrow(/403/)
  })

  it('throws on 500 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server broke',
    })

    const client = new OrchestratorClient(BASE_URL)
    await expect(client.sendMessage(sampleMessage)).rejects.toThrow(/500/)
  })

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const client = new OrchestratorClient(BASE_URL)
    await expect(client.sendMessage(sampleMessage)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('uses 120s timeout signal', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'ok', sessionId: 'sess-1' }),
    })

    const client = new OrchestratorClient(BASE_URL)
    await client.sendMessage(sampleMessage)

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = callArgs[1] as RequestInit
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('includes context in error message for non-ok responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => 'Invalid scope',
    })

    const client = new OrchestratorClient(BASE_URL)
    await expect(client.sendMessage(sampleMessage)).rejects.toThrow(
      /orchestrator/i,
    )
  })

  it('uses default timeout of 120000ms', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'ok', sessionId: 'sess-1' }),
    })

    const client = new OrchestratorClient(BASE_URL)
    await client.sendMessage(sampleMessage)

    expect(timeoutSpy).toHaveBeenCalledWith(120_000)
    timeoutSpy.mockRestore()
  })
})
