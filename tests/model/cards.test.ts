import { describe, expect, test } from 'vitest'
import {
  makeProseCardProps, makeSourceCardProps, isProseCard, isSourceCard,
  claudeMayEditCardText, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from '../../src/model/cards'

describe('card factories', () => {
  test('prose card defaults to your voice, no source metadata', () => {
    const p = makeProseCardProps('a point I wrote')
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      sourceKind: null, origin: null, text: 'a point I wrote',
    })
    expect(isProseCard(p)).toBe(true)
    expect(isSourceCard(p)).toBe(false)
  })

  test('source card is typed reference material by default', () => {
    const s = makeSourceCardProps('raw note')
    expect(s.kind).toBe('source')
    expect(s.sourceKind).toBe('text')
    expect(s.origin).toBe('typed')
    expect(isSourceCard(s)).toBe(true)
  })

  test('source card origin can be set', () => {
    expect(makeSourceCardProps('x', 'tana').origin).toBe('tana')
  })
})

describe('core invariant: Claude never authors card text', () => {
  test('Claude may not edit the text of any existing card', () => {
    expect(claudeMayEditCardText('prose')).toBe(false)
    expect(claudeMayEditCardText('source')).toBe(false)
  })
})
