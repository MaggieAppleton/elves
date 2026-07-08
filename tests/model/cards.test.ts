import { describe, expect, test } from 'vitest'
import {
  makeProseCardProps, makeNoteCardProps, makeImageNoteCardProps, makeReferenceCardProps,
  makeFigureCardProps, isProseCard, isNoteCard, isFigureCard, claudeMayEditCardText,
  canConvertNoteToProse, noteToProseProps,
  CARD_DEFAULT_W, CARD_DEFAULT_H, FIGURE_DEFAULT_W, FIGURE_DEFAULT_H, AGENT_CARD_DEFAULT_W,
} from '../../src/model/cards'
import type { Comment } from '../../src/model/types'
import { blankReference } from '../../src/model/references'

describe('card factories', () => {
  test('prose card defaults to your voice, no source metadata', () => {
    const p = makeProseCardProps('a point I wrote')
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      noteKind: null, origin: null, text: 'a point I wrote', authoredBy: null,
      attribution: [{ author: 'user', length: 'a point I wrote'.length }],
      comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null,
      figureTitle: '', figureStatus: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
    expect(isProseCard(p)).toBe(true)
    expect(isNoteCard(p)).toBe(false)
    expect(isFigureCard(p)).toBe(false)
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

  test('agent-added cards are born wide; hand-made ones stay small', () => {
    // A human drags out a small box and grows it as they type.
    expect(makeNoteCardProps('x').w).toBe(CARD_DEFAULT_W)
    expect(makeFigureCardProps('t', 'd').w).toBe(FIGURE_DEFAULT_W)
    // A Claude-written note or figure arrives at a comfortable reading width.
    expect(makeNoteCardProps('x', 'transcribed', 'claude').w).toBe(AGENT_CARD_DEFAULT_W)
    expect(makeFigureCardProps('t', 'd', 'claude').w).toBe(AGENT_CARD_DEFAULT_W)
  })

  test('makeImageNoteCardProps builds an image note card', () => {
    const p = makeImageNoteCardProps('abc.png')
    expect(p).toEqual({
      w: 280, h: 200, kind: 'note', noteKind: 'image', origin: 'image',
      text: '', authoredBy: null, attribution: [], comments: [], mergedInto: null, draftExcluded: false, assetId: 'abc.png', reference: null,
      figureTitle: '', figureStatus: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
  })

  test('figure card holds a title, description-as-text, and an idea status', () => {
    const p = makeFigureCardProps('Malleable software spectrum', 'A horizontal axis from rigid to malleable, with tools placed along it')
    expect(p).toEqual({
      w: FIGURE_DEFAULT_W, h: FIGURE_DEFAULT_H, kind: 'figure',
      noteKind: null, origin: null,
      // The description lives in `text`; the title is its own field.
      text: 'A horizontal axis from rigid to malleable, with tools placed along it',
      figureTitle: 'Malleable software spectrum', figureStatus: 'idea',
      authoredBy: null,
      attribution: [{ author: 'user', length: 'A horizontal axis from rigid to malleable, with tools placed along it'.length }],
      comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
    expect(isFigureCard(p)).toBe(true)
    expect(isProseCard(p)).toBe(false)
    expect(isNoteCard(p)).toBe(false)
  })

  test('figure card can be stamped with an agent id (Claude suggests, I decide)', () => {
    // A human-drawn figure carries no mark; a Claude-suggested one carries its id.
    expect(makeFigureCardProps('t', 'd').authoredBy).toBeNull()
    expect(makeFigureCardProps('t', 'd', 'claude').authoredBy).toBe('claude')
  })

  test('figure defaults are blank but well-formed', () => {
    const p = makeFigureCardProps()
    expect(p.figureTitle).toBe('')
    expect(p.text).toBe('')
    expect(p.figureStatus).toBe('idea')
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

describe('convert note → prose', () => {
  test('only a text note can be converted', () => {
    expect(canConvertNoteToProse(makeNoteCardProps('a point'))).toBe(true)
    // Image and reference notes hold an annotation / structured data, not prose.
    expect(canConvertNoteToProse(makeImageNoteCardProps('a.png'))).toBe(false)
    expect(canConvertNoteToProse(makeReferenceCardProps(blankReference('https://x', '2026-07-02T00:00:00.000Z')))).toBe(false)
    // Prose and figure cards have nowhere to go.
    expect(canConvertNoteToProse(makeProseCardProps('x'))).toBe(false)
    expect(canConvertNoteToProse(makeFigureCardProps('t', 'd'))).toBe(false)
  })

  test('conversion flips kind to prose and clears note metadata', () => {
    const note = makeNoteCardProps('my paragraph', 'tana')
    const prose = noteToProseProps(note)
    expect(prose.kind).toBe('prose')
    expect(prose.noteKind).toBeNull()
    expect(prose.origin).toBeNull()
    expect(isProseCard(prose)).toBe(true)
    expect(isNoteCard(prose)).toBe(false)
  })

  test('conversion preserves the text, comments, size, and authorship', () => {
    const comments: Comment[] = [
      { id: 'c1', type: 'needs-citation', text: 'source?', resolved: false, author: 'claude' },
    ]
    const note = { ...makeNoteCardProps('written by an agent', 'transcribed', 'claude'), comments, w: 512, h: 240 }
    const prose = noteToProseProps(note)
    expect(prose.text).toBe('written by an agent')
    expect(prose.comments).toBe(comments)
    expect(prose.authoredBy).toBe('claude')
    expect(prose.w).toBe(512)
    expect(prose.h).toBe(240)
  })

  test('after conversion the prose boundary protects the text from agent edits', () => {
    // The whole point: a converted note now compiles into the draft AND becomes
    // off-limits to agent text edits, exactly like a born-prose card.
    const prose = noteToProseProps(makeNoteCardProps('now part of the draft'))
    expect(claudeMayEditCardText(prose.kind)).toBe(false)
  })
})

describe('core invariant: Claude never edits the user\'s prose', () => {
  test('a prose card holds the user\'s own draft — never Claude\'s to edit', () => {
    expect(claudeMayEditCardText('prose')).toBe(false)
  })

  test('notes and figures are working material Claude may edit', () => {
    // Notes, references (a note kind), and figures are scaffolding Claude helps
    // maintain — only the prose draft above is off limits.
    expect(claudeMayEditCardText('note')).toBe(true)
    expect(claudeMayEditCardText('figure')).toBe(true)
  })
})
