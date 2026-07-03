import { describe, expect, test } from 'vitest'
import {
  makeProseCardProps, makeNoteCardProps, makeImageNoteCardProps, makeReferenceCardProps,
  isProseCard, isNoteCard, claudeMayEditCardText, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from '../../src/model/cards'
import { blankReference } from '../../src/model/references'

describe('card factories', () => {
  test('prose card defaults to your voice, no source metadata', () => {
    const p = makeProseCardProps('a point I wrote')
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      noteKind: null, origin: null, text: 'a point I wrote', authoredBy: null,
      comments: [], mergedInto: null, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
    expect(isProseCard(p)).toBe(true)
    expect(isNoteCard(p)).toBe(false)
  })

  test('note card is typed reference material by default', () => {
    const s = makeNoteCardProps('raw note')
    expect(s.kind).toBe('note')
    expect(s.noteKind).toBe('text')
    expect(s.origin).toBe('typed')
    expect(s.comments).toEqual([])
    expect(s.mergedInto).toBeNull()
    expect(s.assetId).toBeNull()
    expect(isNoteCard(s)).toBe(true)
  })

  test('note card origin can be set', () => {
    expect(makeNoteCardProps('x', 'tana').origin).toBe('tana')
  })

  test('note card is human-authored by default, and can be stamped with an agent id', () => {
    // Default: no agent — a human made it, so no authorship mark.
    expect(makeNoteCardProps('x').authoredBy).toBeNull()
    // An agent (its changeset author) stamps its id onto the card it creates.
    expect(makeNoteCardProps('x', 'transcribed', 'claude').authoredBy).toBe('claude')
    // Prose, image, and reference cards are never agent-authored.
    expect(makeProseCardProps('x').authoredBy).toBeNull()
    expect(makeImageNoteCardProps('a.png').authoredBy).toBeNull()
  })

  test('makeImageNoteCardProps builds an image note card', () => {
    const p = makeImageNoteCardProps('abc.png')
    expect(p).toEqual({
      w: 280, h: 200, kind: 'note', noteKind: 'image', origin: 'image',
      text: '', authoredBy: null, comments: [], mergedInto: null, assetId: 'abc.png', reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
  })

  test('makeReferenceCardProps builds a reference note card with empty annotation', () => {
    const reference = blankReference('https://arxiv.org/abs/1', '2026-07-02T00:00:00.000Z')
    const p = makeReferenceCardProps(reference)
    expect(p.kind).toBe('note')
    expect(p.noteKind).toBe('reference')
    expect(p.origin).toBe('reference')
    expect(p.text).toBe('') // annotation stays the user's to write
    expect(p.reference).toEqual(reference)
    expect(isNoteCard(p)).toBe(true)
  })
})

describe('core invariant: Claude never authors card text', () => {
  test('Claude may not edit the text of any existing card', () => {
    expect(claudeMayEditCardText('prose')).toBe(false)
    expect(claudeMayEditCardText('note')).toBe(false)
  })
})
