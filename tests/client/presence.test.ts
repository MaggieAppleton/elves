import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { TLShapeId } from 'tldraw'
import {
  markLooking, markDoing, presenceMode, clearPresence,
  LOOKING_TTL_MS, DOING_TTL_MS,
} from '../../src/client/presence'

const id = (s: string) => s as TLShapeId

beforeEach(() => {
  vi.useFakeTimers()
  clearPresence()
})
afterEach(() => {
  clearPresence()
  vi.useRealTimers()
})

describe('markLooking / markDoing', () => {
  test('looking sets a looking mode; doing sets a doing mode', () => {
    markLooking([id('a')])
    markDoing([id('b')])
    expect(presenceMode(id('a'))).toBe('looking')
    expect(presenceMode(id('b'))).toBe('doing')
    expect(presenceMode(id('missing'))).toBeNull()
  })

  test('doing supersedes an active looking on the same card', () => {
    markLooking([id('a')])
    markDoing([id('a')])
    expect(presenceMode(id('a'))).toBe('doing')
  })

  test('looking never downgrades an active doing', () => {
    markDoing([id('a')])
    markLooking([id('a')])
    expect(presenceMode(id('a'))).toBe('doing')
  })

  test('empty id list is a no-op', () => {
    markLooking([])
    markDoing([])
    expect(presenceMode(id('a'))).toBeNull()
  })
})

describe('expiry', () => {
  test('a looking halo fades after LOOKING_TTL_MS', () => {
    markLooking([id('a')])
    vi.advanceTimersByTime(LOOKING_TTL_MS - 1)
    expect(presenceMode(id('a'))).toBe('looking')
    vi.advanceTimersByTime(1)
    expect(presenceMode(id('a'))).toBeNull()
  })

  test('a doing pulse fades after DOING_TTL_MS', () => {
    markDoing([id('a')])
    vi.advanceTimersByTime(DOING_TTL_MS - 1)
    expect(presenceMode(id('a'))).toBe('doing')
    vi.advanceTimersByTime(1)
    expect(presenceMode(id('a'))).toBeNull()
  })

  test('a fresh read refreshes the idle timer (does not expire early)', () => {
    markLooking([id('a')])
    vi.advanceTimersByTime(LOOKING_TTL_MS - 100)
    markLooking([id('a')]) // refresh just before it would fade
    vi.advanceTimersByTime(200) // past the ORIGINAL deadline
    expect(presenceMode(id('a'))).toBe('looking')
    vi.advanceTimersByTime(LOOKING_TTL_MS)
    expect(presenceMode(id('a'))).toBeNull()
  })
})

describe('clearPresence', () => {
  test('empties the store and cancels pending timers', () => {
    markLooking([id('a')])
    markDoing([id('b')])
    clearPresence()
    expect(presenceMode(id('a'))).toBeNull()
    expect(presenceMode(id('b'))).toBeNull()
    // No timer should resurrect or error after clearing.
    vi.advanceTimersByTime(LOOKING_TTL_MS + DOING_TTL_MS)
    expect(presenceMode(id('a'))).toBeNull()
  })
})
