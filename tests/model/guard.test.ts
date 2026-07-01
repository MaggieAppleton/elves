import { expect, test } from 'vitest'
import { changeSetWritesText } from '../../src/model/changeset'

test('none of the Phase 2 ops write card text', () => {
  const cs = {
    id: 'x', author: 'claude' as const,
    ops: [
      { kind: 'add_comment' as const, cardId: 'a', comment: { type: null, text: 'note' } },
      { kind: 'merge_sources' as const, cardIds: ['a', 'b'] },
      { kind: 'move_cards' as const, moves: [{ cardId: 'a', x: 1, y: 2 }] },
    ],
  }
  expect(changeSetWritesText(cs)).toBe(false)
})
