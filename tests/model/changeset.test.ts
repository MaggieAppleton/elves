import { describe, expect, test } from 'vitest'
import type { Reference } from '../../src/model/types'
import {
  isChangeSet, isReference, planMerge, referencedCardIds, referencedSectionIds,
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
        { kind: 'merge_sources', cardIds: ['a', 'b'] },
        { kind: 'move_cards', moves: [{ cardId: 'a', x: 10, y: 20 }] },
        { kind: 'create_source_card', text: 'transcribed words', x: 10, y: 20 },
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
  test('rejects a malformed create_source_card', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_source_card', text: 'hi' }] })).toBe(false) // missing x/y
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
  test('collects existing-card references, ignores create_source_card and create_reference', () => {
    const cs = {
      id: 'x', author: 'claude' as const, ops: [
        { kind: 'add_comment' as const, cardId: 'shape:a', comment: { type: null, text: 'hi' } },
        { kind: 'merge_sources' as const, cardIds: ['shape:b', 'shape:c'] },
        { kind: 'move_cards' as const, moves: [{ cardId: 'shape:d', x: 1, y: 2 }] },
        { kind: 'create_source_card' as const, text: 't', x: 0, y: 0 },
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
