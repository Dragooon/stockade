import { describe, it, expect } from 'vitest'
import { buildScope, parseScope } from '../src/scope.js'

describe('buildScope', () => {
  it('joins parts with colons', () => {
    expect(buildScope(['discord', '123', '456', '789'])).toBe('discord:123:456:789')
  })

  it('builds terminal scope', () => {
    expect(buildScope(['terminal', 'local', 'session-1', 'alice'])).toBe(
      'terminal:local:session-1:alice',
    )
  })

  it('builds discord thread scope with 5 parts', () => {
    expect(buildScope(['discord', '111', '222', '333', '444'])).toBe(
      'discord:111:222:333:444',
    )
  })

  it('throws on empty parts array', () => {
    expect(() => buildScope([])).toThrow()
  })

  it('throws on single part', () => {
    expect(() => buildScope(['discord'])).toThrow()
  })

  it('throws if any segment is empty string', () => {
    expect(() => buildScope(['discord', '', '456'])).toThrow()
  })

  it('throws if any segment contains a colon', () => {
    expect(() => buildScope(['discord', 'a:b', '456'])).toThrow()
  })
})

describe('parseScope', () => {
  it('parses discord scope', () => {
    const result = parseScope('discord:123:456:789')
    expect(result).toEqual({ platform: 'discord', parts: ['123', '456', '789'] })
  })

  it('parses terminal scope', () => {
    const result = parseScope('terminal:local:session-1:alice')
    expect(result).toEqual({
      platform: 'terminal',
      parts: ['local', 'session-1', 'alice'],
    })
  })

  it('parses discord thread scope', () => {
    const result = parseScope('discord:111:222:333:444')
    expect(result).toEqual({
      platform: 'discord',
      parts: ['111', '222', '333', '444'],
    })
  })

  it('throws on empty string', () => {
    expect(() => parseScope('')).toThrow()
  })

  it('throws on scope with no parts after platform', () => {
    expect(() => parseScope('discord')).toThrow()
  })
})

describe('roundtrip', () => {
  it('build then parse returns original parts', () => {
    const parts = ['discord', '123', '456', '789']
    const scope = buildScope(parts)
    const parsed = parseScope(scope)
    expect(parsed.platform).toBe('discord')
    expect([parsed.platform, ...parsed.parts]).toEqual(parts)
  })
})
