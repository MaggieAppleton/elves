import { describe, expect, test } from 'vitest'
import { isChangeSet, planMerge, referencedCardIds } from '../../src/model/changeset'

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
})

describe('referencedCardIds', () => {
  test('collects existing-card references, ignores create_source_card', () => {
    const cs = {
      id: 'x', author: 'claude' as const, ops: [
        { kind: 'add_comment' as const, cardId: 'shape:a', comment: { type: null, text: 'hi' } },
        { kind: 'merge_sources' as const, cardIds: ['shape:b', 'shape:c'] },
        { kind: 'move_cards' as const, moves: [{ cardId: 'shape:d', x: 1, y: 2 }] },
        { kind: 'create_source_card' as const, text: 't', x: 0, y: 0 },
      ],
    }
    expect(referencedCardIds(cs).sort()).toEqual(['shape:a', 'shape:b', 'shape:c', 'shape:d'])
  })
})
