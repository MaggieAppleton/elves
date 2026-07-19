import { describe, expect, test } from 'vitest'
import {
  compileDraft,
  compilesToDraft,
  toReadDraftBlocks,
  draftToMarkdown,
  type DraftCardInput,
  type DraftSectionInput,
} from '../../src/model/draft'

// A prose card with a sensible default box; override what a test cares about.
function card(over: Partial<DraftCardInput> & { id: string }): DraftCardInput {
  return {
    kind: 'prose',
    x: 0, y: 0, w: 240, h: 120,
    text: over.id,
    mergedInto: null,
    draftExcluded: false,
    ...over,
  }
}

function section(id: string, x: number, over: Partial<DraftSectionInput> = {}): DraftSectionInput {
  return { id, x, text: id, authoredBy: 'user', ...over }
}

// The ids of every card, block by block — the reading order, compactly.
function order(blocks: ReturnType<typeof compileDraft>): (string | null)[][] {
  return blocks.map((b) => [b.sectionId, ...b.items.map((c) => c.id)])
}

describe('compileDraft — band assignment', () => {
  test('sections run left→right; a card joins the last section whose left edge ≤ its center x', () => {
    const sections = [section('B', 1000), section('A', 0)] // deliberately unsorted
    const cards = [
      card({ id: 'a1', x: 100, y: 0 }), // center 220 → band A
      card({ id: 'b1', x: 1100, y: 0 }), // center 1220 → band B
    ]
    expect(order(compileDraft(cards, sections))).toEqual([
      ['A', 'a1'],
      ['B', 'b1'],
    ])
  })

  test('within a section, cards run top→bottom — NOT by their x', () => {
    // The load-bearing distinction from a plain left-to-right scan of x: the card
    // further RIGHT but higher (X) must precede the one further LEFT but lower (Y).
    const sections = [section('A', 0), section('B', 5000)]
    const cards = [
      card({ id: 'Y', x: 10, y: 300 }),
      card({ id: 'X', x: 400, y: 0 }),
    ]
    expect(order(compileDraft(cards, sections))).toEqual([['A', 'X', 'Y']])
  })

  test('cards left of the first section compile first, as an unlabeled opening block', () => {
    const sections = [section('A', 500)]
    const cards = [
      card({ id: 'intro', x: 0, y: 0 }), // center 120 < 500 → opening
      card({ id: 'a1', x: 520, y: 0 }), // center 640 ≥ 500 → band A
    ]
    const blocks = compileDraft(cards, sections)
    expect(blocks[0].sectionId).toBeNull()
    expect(blocks[0].section).toBeNull()
    expect(order(blocks)).toEqual([
      [null, 'intro'],
      ['A', 'a1'],
    ])
  })

  test('a card whose center sits exactly on a section left edge joins that section', () => {
    // center x === left edge counts as "≤", so it belongs to the section, not the
    // band before it.
    const sections = [section('A', 0), section('B', 300)]
    const cards = [card({ id: 'edge', x: 300 - 120, y: 0 })] // center exactly 300
    expect(order(compileDraft(cards, sections))).toEqual([['B', 'edge']])
  })

  test('tiebreak: cards at the same center y order left→right by center x (columns)', () => {
    const sections = [section('A', 0)]
    const cards = [
      card({ id: 'right', x: 400, y: 0 }),
      card({ id: 'left', x: 0, y: 0 }),
    ]
    expect(order(compileDraft(cards, sections))).toEqual([['A', 'left', 'right']])
  })

  test('a section with no cards is dropped (no heading without prose)', () => {
    const sections = [section('A', 0), section('empty', 1000), section('C', 2000)]
    const cards = [
      card({ id: 'a1', x: 10, y: 0 }),
      card({ id: 'c1', x: 2010, y: 0 }),
    ]
    expect(order(compileDraft(cards, sections))).toEqual([
      ['A', 'a1'],
      ['C', 'c1'],
    ])
  })

  test('no sections at all: everything is one opening block in top→bottom order', () => {
    const cards = [
      card({ id: 'second', x: 0, y: 200 }),
      card({ id: 'first', x: 900, y: 0 }),
    ]
    expect(order(compileDraft(cards, []))).toEqual([[null, 'first', 'second']])
  })

  test('prose, figures, and images share the same top-to-bottom order inside a section', () => {
    const sections = [section('A', 0)]
    const cards = [
      card({ id: 'after', x: 10, y: 300, text: 'after visual' }),
      card({
        id: 'figure',
        kind: 'figure',
        x: 10,
        y: 100,
        text: 'Show the feedback loop.',
        figureTitle: 'Feedback loop',
        figureStatus: 'sketched',
      }),
      card({
        id: 'image',
        kind: 'note',
        noteKind: 'image',
        x: 10,
        y: 200,
        text: '',
        assetId: 'diagram.png',
      }),
      card({ id: 'before', x: 10, y: 0, text: 'before visual' }),
    ]
    expect(order(compileDraft(cards, sections))).toEqual([['A', 'before', 'figure', 'image', 'after']])
  })
})

describe('compileDraft — what is skipped', () => {
  test('merged-away, draft-excluded, and non-prose cards never compile', () => {
    const sections = [section('A', 0)]
    const cards = [
      card({ id: 'keep', x: 10, y: 0 }),
      card({ id: 'merged', x: 10, y: 100, mergedInto: 'keep' }),
      card({ id: 'excluded', x: 10, y: 200, draftExcluded: true }),
      card({ id: 'note', x: 10, y: 300, kind: 'note' }),
    ]
    expect(order(compileDraft(cards, sections))).toEqual([['A', 'keep']])
  })

  test('compilesToDraft is the single source of truth for the filter', () => {
    expect(compilesToDraft(card({ id: 'p' }))).toBe(true)
    expect(compilesToDraft(card({ id: 'n', kind: 'note' }))).toBe(false)
    expect(compilesToDraft(card({ id: 'i', kind: 'note', noteKind: 'image', assetId: 'i.png' }))).toBe(true)
    expect(compilesToDraft(card({ id: 'f', kind: 'figure', figureTitle: 'F' }))).toBe(true)
    expect(compilesToDraft(card({ id: 'm', mergedInto: 'x' }))).toBe(false)
    expect(compilesToDraft(card({ id: 'e', draftExcluded: true }))).toBe(false)
  })
})

describe('compileDraft — carried metadata', () => {
  test('heading text and author come through for the pane', () => {
    const sections = [section('A', 0, { text: 'The turn', authoredBy: 'claude' })]
    const [block] = compileDraft([card({ id: 'a1', x: 10 })], sections)
    expect(block.section).toBe('The turn')
    expect(block.authoredBy).toBe('claude')
  })

  test('unresolvedComments is carried through when set, omitted when not', () => {
    const sections = [section('A', 0)]
    const cards = [
      card({ id: 'flagged', x: 10, y: 0, unresolvedComments: 2 }),
      card({ id: 'clean', x: 10, y: 100 }),
    ]
    const [block] = compileDraft(cards, sections)
    expect(block.items[0]).toEqual({ type: 'prose', id: 'flagged', text: 'flagged', unresolvedComments: 2 })
    expect(block.items[1]).toEqual({ type: 'prose', id: 'clean', text: 'clean' })
    expect('unresolvedComments' in block.items[1]).toBe(false)
  })
})

describe('toReadDraftBlocks — the MCP contract', () => {
  test('projects blocks down to ordered typed items, dropping pane-only counts', () => {
    const sections = [section('A', 0, { text: 'Origins' })]
    const cards = [
      card({ id: 'a1', x: 10, y: 0, text: 'a real point', unresolvedComments: 3 }),
      card({
        id: 'fig',
        kind: 'figure',
        x: 10,
        y: 100,
        text: 'Show the shape.',
        figureTitle: 'Shape',
        figureStatus: 'final',
      }),
      card({
        id: 'img',
        kind: 'note',
        noteKind: 'image',
        x: 10,
        y: 200,
        text: '',
        assetId: 'shape.png',
      }),
    ]
    const blocks = compileDraft(cards, sections)
    expect(toReadDraftBlocks(blocks)).toEqual([
      {
        section: 'Origins',
        items: [
          { type: 'prose', id: 'a1', text: 'a real point' },
          {
            type: 'figure',
            id: 'fig',
            title: 'Shape',
            description: 'Show the shape.',
            status: 'final',
          },
          { type: 'image', id: 'img', assetId: 'shape.png' },
        ],
      },
    ])
  })

  test('the opening block reports section: null', () => {
    const blocks = compileDraft([card({ id: 'intro', x: 0, text: 'hi' })], [])
    expect(toReadDraftBlocks(blocks)).toEqual([{ section: null, items: [{ type: 'prose', id: 'intro', text: 'hi' }] }])
  })
})

describe('draftToMarkdown', () => {
  test('## headings + blank-line-separated paragraphs, opening block unlabeled', () => {
    const sections = [section('A', 500, { text: 'Origins' })]
    const cards = [
      card({ id: 'intro', x: 0, y: 0, text: 'An opening thought.' }),
      card({ id: 'a1', x: 520, y: 0, text: 'First real point.' }),
      card({ id: 'a2', x: 520, y: 200, text: 'Second real point.' }),
    ]
    const md = draftToMarkdown(compileDraft(cards, sections))
    expect(md).toBe(
      'An opening thought.\n\n## Origins\n\nFirst real point.\n\nSecond real point.',
    )
  })

  test('empty-text cards are dropped, and a section that ends up empty is dropped', () => {
    const sections = [section('A', 0, { text: 'A' }), section('B', 1000, { text: 'B' })]
    const cards = [
      card({ id: 'a1', x: 10, text: 'kept' }),
      card({ id: 'blank', x: 1010, text: '   ' }), // only card in B, blank
    ]
    expect(draftToMarkdown(compileDraft(cards, sections))).toBe('## A\n\nkept')
  })

  test('figures and images export in narrative order with surrounding prose', () => {
    const sections = [section('A', 0, { text: 'Results' })]
    const cards = [
      card({ id: 'before', x: 10, y: 0, text: 'Before.' }),
      card({
        id: 'fig',
        kind: 'figure',
        x: 10,
        y: 100,
        text: 'Show the loop.',
        figureTitle: 'Loop diagram',
        figureStatus: 'idea',
      }),
      card({
        id: 'img',
        kind: 'note',
        noteKind: 'image',
        x: 10,
        y: 200,
        text: '',
        assetId: 'loop.png',
      }),
      card({ id: 'after', x: 10, y: 300, text: 'After.' }),
    ]
    expect(draftToMarkdown(compileDraft(cards, sections))).toBe(
      '## Results\n\nBefore.\n\n' +
      '[Figure: Loop diagram]\n\nStatus: idea\n\nShow the loop.\n\n' +
      '![Image](loop.png)\n\nAfter.',
    )
  })
})
