import { describe, expect, test } from 'vitest'
import { makeSectionProps, SECTION_DEFAULT_W, SECTION_DEFAULT_H } from '../../src/model/sections'

describe('section factory', () => {
  test('defaults to a user-authored empty label', () => {
    const p = makeSectionProps()
    expect(p).toEqual({ w: SECTION_DEFAULT_W, h: SECTION_DEFAULT_H, text: '', authoredBy: 'user' })
  })

  test('text and authoredBy can be set', () => {
    const p = makeSectionProps('Origins', 'claude')
    expect(p.text).toBe('Origins')
    expect(p.authoredBy).toBe('claude')
  })

  test('authoredBy accepts any agent id, not just claude', () => {
    expect(makeSectionProps('Origins', 'codex').authoredBy).toBe('codex')
  })
})
