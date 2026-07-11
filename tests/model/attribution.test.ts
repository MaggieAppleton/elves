import { describe, expect, test } from 'vitest'
import {
  reattribute, contributors, normalizeAttribution,
  type Attribution,
} from '../../src/model/attribution'

/** sum of run lengths — the load-bearing invariant across every edit. */
const total = (a: Attribution) => a.reduce((n, r) => n + r.length, 0)

describe('normalizeAttribution', () => {
  test('empty text yields an empty attribution', () => {
    expect(normalizeAttribution(null, 0)).toEqual([])
    expect(normalizeAttribution([{ author: 'user', length: 3 }], 0)).toEqual([])
  })

  test('null attribution over non-empty text repairs to a single user run', () => {
    expect(normalizeAttribution(null, 5)).toEqual([{ author: 'user', length: 5 }])
  })

  test('coalesces adjacent same-author runs and drops zero-length runs', () => {
    const a: Attribution = [
      { author: 'user', length: 2 },
      { author: 'user', length: 0 },
      { author: 'user', length: 3 },
      { author: 'claude', length: 4 },
    ]
    expect(normalizeAttribution(a, 9)).toEqual([
      { author: 'user', length: 5 },
      { author: 'claude', length: 4 },
    ])
  })

  test('repairs a length mismatch by falling back to one user run', () => {
    const a: Attribution = [{ author: 'claude', length: 2 }]
    expect(normalizeAttribution(a, 10)).toEqual([{ author: 'user', length: 10 }])
  })
})

describe('reattribute — from a legacy null attribution', () => {
  test('typing into an empty card credits the whole text to the author', () => {
    const out = reattribute('', 'hello', null, 'user')
    expect(out).toEqual([{ author: 'user', length: 5 }])
    expect(total(out)).toBe(5)
  })

  test('an agent editing a null-attributed card seeds a user prefix + agent span', () => {
    const out = reattribute('abc', 'abcXYZ', null, 'claude')
    expect(out).toEqual([
      { author: 'user', length: 3 },
      { author: 'claude', length: 3 },
    ])
    expect(total(out)).toBe(6)
  })
})

describe('reattribute — pure append', () => {
  test('appended text is credited to the new author, prefix preserved', () => {
    const old: Attribution = [{ author: 'user', length: 5 }]
    const out = reattribute('hello', 'hello world', old, 'claude')
    expect(out).toEqual([
      { author: 'user', length: 5 },
      { author: 'claude', length: 6 },
    ])
    expect(total(out)).toBe(11)
  })

  test('appending as the SAME author coalesces into one run', () => {
    const old: Attribution = [{ author: 'user', length: 5 }]
    const out = reattribute('hello', 'hello!!', old, 'user')
    expect(out).toEqual([{ author: 'user', length: 7 }])
  })
})

describe('reattribute — pure prepend', () => {
  test('prepended text is credited to the new author, suffix preserved', () => {
    const old: Attribution = [{ author: 'user', length: 5 }]
    const out = reattribute('world', '> world', old, 'claude')
    expect(out).toEqual([
      { author: 'claude', length: 2 },
      { author: 'user', length: 5 },
    ])
    expect(total(out)).toBe(7)
  })
})

describe('reattribute — insert in the middle (splits a run)', () => {
  test('an agent inserting mid-run splits the user run around the insertion', () => {
    const old: Attribution = [{ author: 'user', length: 10 }] // "0123456789"
    const out = reattribute('0123456789', '01234XX56789', old, 'claude')
    expect(out).toEqual([
      { author: 'user', length: 5 },
      { author: 'claude', length: 2 },
      { author: 'user', length: 5 },
    ])
    expect(total(out)).toBe(12)
  })
})

describe('reattribute — deletion', () => {
  test('deleting a middle span drops those characters, no new run added', () => {
    const old: Attribution = [
      { author: 'user', length: 3 },
      { author: 'claude', length: 4 },
      { author: 'user', length: 3 },
    ] // "aaaCCCCbbb" (10)
    const out = reattribute('aaaCCCCbbb', 'aaabbb', old, 'user')
    expect(out).toEqual([{ author: 'user', length: 6 }])
    expect(total(out)).toBe(6)
  })

  test('deleting everything yields an empty attribution', () => {
    const old: Attribution = [{ author: 'claude', length: 4 }]
    const out = reattribute('text', '', old, 'user')
    expect(out).toEqual([])
    expect(total(out)).toBe(0)
  })
})

describe('reattribute — replace', () => {
  test('replacing a middle span credits only the replacement to the author', () => {
    const old: Attribution = [{ author: 'user', length: 11 }] // "hello world"
    const out = reattribute('hello world', 'hello there', old, 'claude')
    // common prefix "hello " (6), common suffix "" then trailing... compute:
    expect(total(out)).toBe(11)
    // prefix "hello " is user; the changed tail is claude
    expect(out[0]).toEqual({ author: 'user', length: 6 })
    expect(out[out.length - 1].author).toBe('claude')
  })

  test('replacing across an author boundary keeps the untouched halves', () => {
    const old: Attribution = [
      { author: 'user', length: 5 },   // "hello"
      { author: 'claude', length: 6 }, // " world"
    ]
    // replace the middle "o wo" -> "O_WO"
    const out = reattribute('hello world', 'hellO_WOrld', old, 'agent2')
    expect(total(out)).toBe(11)
    expect(contributors(out)).toContain('agent2')
  })
})

describe('reattribute — edits at boundaries', () => {
  test('insertion exactly at an author boundary attaches to the editing author', () => {
    const old: Attribution = [
      { author: 'user', length: 5 },
      { author: 'claude', length: 5 },
    ] // "AAAAABBBBB"
    const out = reattribute('AAAAABBBBB', 'AAAAA__BBBBB', old, 'user')
    // common prefix "AAAAA" (5), suffix "BBBBB" (5), inserted "__" (2) -> user
    expect(out).toEqual([
      { author: 'user', length: 7 },
      { author: 'claude', length: 5 },
    ])
    expect(total(out)).toBe(12)
  })

  test('replacing the whole text credits everything to the author', () => {
    const old: Attribution = [{ author: 'user', length: 3 }]
    const out = reattribute('abc', 'XYZW', old, 'claude')
    expect(out).toEqual([{ author: 'claude', length: 4 }])
    expect(total(out)).toBe(4)
  })
})

describe('reattribute — no-op edit', () => {
  test('identical text preserves attribution unchanged', () => {
    const old: Attribution = [
      { author: 'user', length: 3 },
      { author: 'claude', length: 2 },
    ]
    const out = reattribute('abcde', 'abcde', old, 'someoneElse')
    expect(out).toEqual(old)
    expect(total(out)).toBe(5)
  })
})

describe('reattribute — length invariant under random-ish edits', () => {
  test('a sequence of edits always sums to the current text length', () => {
    let text = ''
    let attr: Attribution = normalizeAttribution(null, 0)
    const edits: Array<{ next: string; author: string }> = [
      { next: 'The quick', author: 'user' },
      { next: 'The quick brown fox', author: 'user' },
      { next: 'The slow brown fox', author: 'claude' },
      { next: 'The slow brown fox jumps', author: 'user' },
      { next: 'A slow brown fox jumps', author: 'agent2' },
      { next: 'A slow fox jumps', author: 'user' },
      { next: '', author: 'user' },
      { next: 'restart', author: 'claude' },
    ]
    for (const { next, author } of edits) {
      attr = reattribute(text, next, attr, author)
      text = next
      expect(total(attr)).toBe(text.length)
      // never any zero-length or adjacent same-author runs
      for (let i = 0; i < attr.length; i++) {
        expect(attr[i].length).toBeGreaterThan(0)
        if (i > 0) expect(attr[i].author).not.toBe(attr[i - 1].author)
      }
    }
  })
})

describe('contributors', () => {
  test('returns distinct authors in first-appearance order', () => {
    const a: Attribution = [
      { author: 'user', length: 2 },
      { author: 'claude', length: 3 },
      { author: 'user', length: 1 },
      { author: 'agent2', length: 4 },
    ]
    expect(contributors(a)).toEqual(['user', 'claude', 'agent2'])
  })

  test('null / empty attribution has no contributors', () => {
    expect(contributors(null)).toEqual([])
    expect(contributors([])).toEqual([])
  })
})
