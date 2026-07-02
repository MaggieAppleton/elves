import { expect, test } from 'vitest'
import { changeSetWritesText } from '../../src/model/changeset'

test('none of the Phase 2 ops write card text', () => {
  const cs = {
    id: 'x', author: 'claude' as const,
    ops: [
      { kind: 'add_comment' as const, cardId: 'a', comment: { type: null, text: 'note' } },
      { kind: 'merge_sources' as const, cardIds: ['a', 'b'] },
      { kind: 'move_cards' as const, moves: [{ cardId: 'a', x: 1, y: 2 }] },
      { kind: 'create_source_card' as const, text: 'note', x: 1, y: 2 },
    ],
  }
  expect(changeSetWritesText(cs)).toBe(false)
})

test('an unknown op kind is treated as unsafe (writes text)', () => {
  const cs = { id: 'x', author: 'claude' as const, ops: [{ kind: 'edit_text', cardId: 'a', text: 'no' }] as any }
  expect(changeSetWritesText(cs)).toBe(true)
})

test('section ops, including edit_section_text, do not count as writing CARD text', () => {
  const cs = {
    id: 'x', author: 'claude' as const,
    ops: [
      { kind: 'create_section' as const, text: 'Origins', x: 0, y: 0 },
      { kind: 'move_sections' as const, moves: [{ sectionId: 'a', x: 1, y: 2 }] },
      { kind: 'edit_section_text' as const, sectionId: 'a', text: 'The turn' },
    ],
  }
  expect(changeSetWritesText(cs)).toBe(false)
})
