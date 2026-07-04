import { describe, expect, test } from 'vitest'
import type { Reference } from '../../src/model/types'
import {
  isChangeSet, isReference, planMerge, referencedCardIds, referencedSectionIds, changeSetWritesText,
} from '../../src/model/changeset'

const VALID_REF: Reference = {
  url: 'https://arxiv.org/abs/2501.01234', refType: 'paper', title: 'A paper',
  authors: ['Cao', 'Jiang'], siteName: 'arxiv.org', year: 2025, venue: 'CHI 2025',
  description: null, faviconAssetId: null, thumbnailAssetId: null, doi: null,
  arxivId: '2501.01234', fetchedBy: 'claude', fetchedAt: '2026-07-02T00:00:00.000Z',
}

describe('planMerge', () => {
  test('first card is the representative, the rest are hidden', () => {
    expect(planMerge(['a', 'b', 'c'])).toEqual({ representativeId: 'a', hiddenIds: ['b', 'c'] })
  })
  test('deduplicates and never hides the representative', () => {
    expect(planMerge(['a', 'b', 'b', 'a'])).toEqual({ representativeId: 'a', hiddenIds: ['b'] })
  })
})

describe('isChangeSet', () => {
  test('accepts a well-formed change-set', () => {
    const cs = {
      id: 'x', author: 'claude',
      ops: [
        { kind: 'add_comment', cardId: 'card1', comment: { type: 'needs-evidence', text: 'hi' } },
        { kind: 'merge_notes', cardIds: ['a', 'b'] },
        { kind: 'move_cards', moves: [{ cardId: 'a', x: 10, y: 20 }] },
        { kind: 'create_note_card', text: 'transcribed words', x: 10, y: 20 },
      ],
    }
    expect(isChangeSet(cs)).toBe(true)
  })
  test('rejects unknown op kinds and malformed shapes', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'edit_text', cardId: 'a' }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: 'nope' })).toBe(false)
    expect(isChangeSet(null)).toBe(false)
    expect(isChangeSet({ id: 'x', ops: [] })).toBe(false) // missing author
  })
  test('author is any non-empty agent id, so future agents validate too', () => {
    const ops = [{ kind: 'create_note_card', text: 'hi', x: 0, y: 0 }]
    expect(isChangeSet({ id: 'x', author: 'claude', ops })).toBe(true)
    expect(isChangeSet({ id: 'x', author: 'openai', ops })).toBe(true) // a future agent
    expect(isChangeSet({ id: 'x', author: '', ops })).toBe(false) // empty id
    expect(isChangeSet({ id: 'x', author: 42, ops })).toBe(false) // non-string
  })
  test('rejects a malformed create_note_card', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_note_card', text: 'hi' }] })).toBe(false) // missing x/y
  })
  test('accepts the section ops', () => {
    const cs = {
      id: 'x', author: 'claude',
      ops: [
        { kind: 'create_section', text: 'Origins', x: 0, y: 0 },
        { kind: 'move_sections', moves: [{ sectionId: 'a', x: 1, y: 2 }] },
        { kind: 'edit_section_text', sectionId: 'a', text: 'The turn' },
      ],
    }
    expect(isChangeSet(cs)).toBe(true)
  })
  test('rejects malformed section ops', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_section', text: 'hi' }] })).toBe(false) // missing x/y
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'move_sections', moves: [{ x: 1, y: 2 }] }] })).toBe(false) // missing sectionId
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'edit_section_text', sectionId: 'a' }] })).toBe(false) // missing text
  })

  test('accepts a well-formed create_figure_card', () => {
    const cs = {
      id: 'x', author: 'claude',
      ops: [{ kind: 'create_figure_card', title: 'Spectrum', description: 'rigid → malleable axis', x: 0, y: 0 }],
    }
    expect(isChangeSet(cs)).toBe(true)
  })
  test('rejects a malformed create_figure_card', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_figure_card', title: 'x', description: 'y' }] })).toBe(false) // missing x/y
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_figure_card', title: 'x', x: 0, y: 0 }] })).toBe(false) // missing description
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_figure_card', description: 'y', x: 0, y: 0 }] })).toBe(false) // missing title
  })

  test('accepts a wants-figure comment (Claude flagging a spot for a visual)', () => {
    const cs = {
      id: 'x', author: 'claude',
      ops: [{ kind: 'add_comment', cardId: 'card1', comment: { type: 'wants-figure', text: 'this spatial relationship is a diagram' } }],
    }
    expect(isChangeSet(cs)).toBe(true)
  })
})

describe('isReference', () => {
  test('accepts a well-formed reference', () => {
    expect(isReference(VALID_REF)).toBe(true)
  })
  test('rejects a bad refType, missing url, or wrong author shape', () => {
    expect(isReference({ ...VALID_REF, refType: 'podcast' })).toBe(false)
    expect(isReference({ ...VALID_REF, url: 123 })).toBe(false)
    expect(isReference({ ...VALID_REF, authors: [1, 2] })).toBe(false)
    expect(isReference({ ...VALID_REF, year: '2025' })).toBe(false)
    expect(isReference(null)).toBe(false)
  })
})

describe('create_reference in a change-set', () => {
  test('isChangeSet accepts create_reference with a valid reference', () => {
    const cs = { id: 'x', author: 'claude', ops: [{ kind: 'create_reference', reference: VALID_REF, x: 1, y: 2 }] }
    expect(isChangeSet(cs)).toBe(true)
  })
  test('rejects create_reference with a malformed reference or missing coords', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_reference', reference: { url: 'x' }, x: 1, y: 2 }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_reference', reference: VALID_REF, x: 1 }] })).toBe(false)
  })
})

describe('referencedCardIds', () => {
  test('collects existing-card references, ignores create_note_card and create_reference', () => {
    const cs = {
      id: 'x', author: 'claude' as const, ops: [
        { kind: 'add_comment' as const, cardId: 'shape:a', comment: { type: null, text: 'hi' } },
        { kind: 'merge_notes' as const, cardIds: ['shape:b', 'shape:c'] },
        { kind: 'move_cards' as const, moves: [{ cardId: 'shape:d', x: 1, y: 2 }] },
        { kind: 'create_note_card' as const, text: 't', x: 0, y: 0 },
        { kind: 'create_reference' as const, reference: VALID_REF, x: 0, y: 0 },
      ],
    }
    expect(referencedCardIds(cs).sort()).toEqual(['shape:a', 'shape:b', 'shape:c', 'shape:d'])
  })
})

describe('referencedSectionIds', () => {
  test('collects existing-section references, ignores create_section', () => {
    const cs = {
      id: 'x', author: 'claude' as const, ops: [
        { kind: 'move_sections' as const, moves: [{ sectionId: 'shape:a', x: 1, y: 2 }] },
        { kind: 'edit_section_text' as const, sectionId: 'shape:b', text: 'new label' },
        { kind: 'create_section' as const, text: 't', x: 0, y: 0 },
      ],
    }
    expect(referencedSectionIds(cs).sort()).toEqual(['shape:a', 'shape:b'])
  })
})

describe('set_summary op', () => {
  const summ = (over: Record<string, unknown> = {}) => ({
    kind: 'set_summary' as const, cardId: 'shape:a',
    summary: 'a gist', summaryOfHash: 'abc', summaryBy: 'ollama/llama3.2',
    summaryAt: '2026-07-03T00:00:00.000Z', ...over,
  })

  test('a well-formed set_summary change-set validates', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [summ()] })).toBe(true)
    // nulls are valid (a clear)
    expect(isChangeSet({
      id: 'x', author: 'claude',
      ops: [summ({ summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null })],
    })).toBe(true)
  })

  test('a malformed set_summary is rejected', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [summ({ cardId: 42 })] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [summ({ summary: 5 })] })).toBe(false)
  })

  test('set_summary does NOT count as writing card text — it is a label about the card', () => {
    expect(changeSetWritesText({ id: 'x', author: 'claude', ops: [summ()] })).toBe(false)
  })

  test('create_figure_card does NOT count as writing prose — it is a placeholder plan', () => {
    expect(changeSetWritesText({
      id: 'x', author: 'claude',
      ops: [{ kind: 'create_figure_card', title: 'Spectrum', description: 'rigid → malleable axis', x: 0, y: 0 }],
    })).toBe(false)
  })

  test('referencedCardIds ignores create_figure_card — it mints a new card, references none', () => {
    expect(referencedCardIds({
      id: 'x', author: 'claude',
      ops: [{ kind: 'create_figure_card', title: 't', description: 'd', x: 0, y: 0 }],
    })).toEqual([])
  })

  test('referencedCardIds includes a set_summary target so the project cross-check applies', () => {
    expect(referencedCardIds({ id: 'x', author: 'claude', ops: [summ()] })).toEqual(['shape:a'])
  })
})

describe('group ops', () => {
  test('isChangeSet accepts well-formed group_cards / ungroup_cards', () => {
    expect(isChangeSet({
      id: 'x', author: 'claude',
      ops: [
        { kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] },
        { kind: 'ungroup_cards', groupId: 'shape:g' },
      ],
    })).toBe(true)
  })

  test('rejects malformed group ops', () => {
    // group_cards needs at least two card ids
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'group_cards', cardIds: ['shape:a'] }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'group_cards', cardIds: 'nope' }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'group_cards', cardIds: [1, 2] }] })).toBe(false)
    // ungroup_cards needs a string groupId
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'ungroup_cards' }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'ungroup_cards', groupId: 5 }] })).toBe(false)
  })

  test('group ops are structural — they never count as writing card text', () => {
    expect(changeSetWritesText({
      id: 'x', author: 'claude',
      ops: [{ kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] }, { kind: 'ungroup_cards', groupId: 'shape:g' }],
    })).toBe(false)
  })

  test('referencedCardIds includes group_cards members but not the ungroup target', () => {
    const cs = {
      id: 'x', author: 'claude' as const, ops: [
        { kind: 'group_cards' as const, cardIds: ['shape:a', 'shape:b'] },
        { kind: 'ungroup_cards' as const, groupId: 'shape:g' },
      ],
    }
    expect(referencedCardIds(cs).sort()).toEqual(['shape:a', 'shape:b'])
  })
})
