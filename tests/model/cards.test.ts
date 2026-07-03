import { describe, expect, test } from 'vitest'
import {
  makeProseCardProps, makeSourceCardProps, makeImageSourceCardProps, makeReferenceCardProps,
  isProseCard, isSourceCard, claudeMayEditCardText, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from '../../src/model/cards'
import { blankReference } from '../../src/model/references'

describe('card factories', () => {
  test('prose card defaults to your voice, no source metadata', () => {
    const p = makeProseCardProps('a point I wrote')
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      sourceKind: null, origin: null, text: 'a point I wrote',
      comments: [], mergedInto: null, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
    expect(isProseCard(p)).toBe(true)
    expect(isSourceCard(p)).toBe(false)
  })

  test('source card is typed reference material by default', () => {
    const s = makeSourceCardProps('raw note')
    expect(s.kind).toBe('source')
    expect(s.sourceKind).toBe('text')
    expect(s.origin).toBe('typed')
    expect(s.comments).toEqual([])
    expect(s.mergedInto).toBeNull()
    expect(s.assetId).toBeNull()
    expect(isSourceCard(s)).toBe(true)
  })

  test('source card origin can be set', () => {
    expect(makeSourceCardProps('x', 'tana').origin).toBe('tana')
  })

  test('makeImageSourceCardProps builds an image source card', () => {
    const p = makeImageSourceCardProps('abc.png')
    expect(p).toEqual({
      w: 280, h: 200, kind: 'source', sourceKind: 'image', origin: 'image',
      text: '', comments: [], mergedInto: null, assetId: 'abc.png', reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
  })

  test('makeReferenceCardProps builds a reference source card with empty annotation', () => {
    const reference = blankReference('https://arxiv.org/abs/1', '2026-07-02T00:00:00.000Z')
    const p = makeReferenceCardProps(reference)
    expect(p.kind).toBe('source')
    expect(p.sourceKind).toBe('reference')
    expect(p.origin).toBe('reference')
    expect(p.text).toBe('') // annotation stays the user's to write
    expect(p.reference).toEqual(reference)
    expect(isSourceCard(p)).toBe(true)
  })
})

describe('core invariant: Claude never authors card text', () => {
  test('Claude may not edit the text of any existing card', () => {
    expect(claudeMayEditCardText('prose')).toBe(false)
    expect(claudeMayEditCardText('source')).toBe(false)
  })
})
