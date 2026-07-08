import { describe, expect, test } from 'vitest'
import { resolveHost } from '../../server/host'

describe('resolveHost', () => {
  test('defaults to loopback', () => {
    expect(resolveHost({})).toBe('127.0.0.1')
  })

  test('ELVES_HOST opts in to a wider bind (e.g. LAN)', () => {
    expect(resolveHost({ ELVES_HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })
})
