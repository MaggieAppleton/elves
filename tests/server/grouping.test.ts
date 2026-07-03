import { expect, test } from 'vitest'
import { applyChangeSetToSnapshot } from '../../server/applyChangeSet'
import { snapshotToCards, snapshotToCardMap, snapshotToGroups } from '../../server/digest'
import type { ChangeSet } from '../../src/model/changeset'

// Two loose, top-level cards whose page coords we can watch survive (un)grouping.
function twoCardSnapshot() {
  return {
    document: {
      store: {
        'page:p': { id: 'page:p', typeName: 'page' },
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 100, y: 50, parentId: 'page:p',
          rotation: 0, index: 'a1', props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'note', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
        'shape:b': {
          id: 'shape:b', typeName: 'shape', type: 'card', x: 130, y: 60, parentId: 'page:p',
          rotation: 0, index: 'a2', props: { w: 240, h: 120, kind: 'source', sourceKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
      },
    },
    session: null,
  }
}

const cs = (...ops: any[]): ChangeSet => ({ id: 'cs', author: 'claude', ops })
function storeOf(snap: any): Record<string, any> {
  return snap.document.store
}

test('group_cards mints a group, reparents members to local coords, and preserves page coords', () => {
  const grouped = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] }))!
  const store = storeOf(grouped)

  const group = Object.values(store).find((r: any) => r.type === 'group') as any
  expect(group).toBeTruthy()
  expect({ x: group.x, y: group.y }).toEqual({ x: 100, y: 50 }) // origin = top-left of members
  expect(group.props).toEqual({}) // tldraw group shapes carry no props

  // Members are now parented to the group with group-LOCAL coords…
  expect(store['shape:a'].parentId).toBe(group.id)
  expect({ x: store['shape:a'].x, y: store['shape:a'].y }).toEqual({ x: 0, y: 0 })
  expect({ x: store['shape:b'].x, y: store['shape:b'].y }).toEqual({ x: 30, y: 10 })

  // …but the digest resolves them back to their original page coords.
  const cards = snapshotToCards(grouped)
  expect(cards.find((c) => c.id === 'shape:a')).toMatchObject({ x: 100, y: 50 })
  expect(cards.find((c) => c.id === 'shape:b')).toMatchObject({ x: 130, y: 60 })

  // …and the map surfaces the binding.
  const map = snapshotToCardMap(grouped)
  expect(map.groups).toEqual([
    { id: group.id, cardIds: ['shape:a', 'shape:b'], memberCount: 2, bounds: { x: 100, y: 50, w: 270, h: 130 } },
  ])
  expect(map.cards.every((c) => c.groupId === group.id)).toBe(true)
})

test('group_cards is a no-op with fewer than two resolvable members', () => {
  const out = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'group_cards', cardIds: ['shape:a', 'shape:missing'] }))!
  expect(Object.values(storeOf(out)).some((r: any) => r.type === 'group')).toBe(false)
  expect(snapshotToGroups(out)).toEqual([])
})

test('ungroup_cards restores page coords to the members and removes the group', () => {
  const grouped = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] }))!
  const groupId = snapshotToGroups(grouped)[0].id

  const ungrouped = applyChangeSetToSnapshot(grouped, cs({ kind: 'ungroup_cards', groupId }))!
  const store = storeOf(ungrouped)

  expect(store[groupId]).toBeUndefined() // group record gone
  expect(store['shape:a'].parentId).toBe('page:p')
  expect({ x: store['shape:a'].x, y: store['shape:a'].y }).toEqual({ x: 100, y: 50 }) // back to page coords
  expect({ x: store['shape:b'].x, y: store['shape:b'].y }).toEqual({ x: 130, y: 60 })
  expect(snapshotToGroups(ungrouped)).toEqual([])
})

test('move_cards on a grouped card writes local coords but lands at the requested PAGE coord', () => {
  const grouped = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] }))!
  const moved = applyChangeSetToSnapshot(grouped, cs({ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 200, y: 200 }] }))!
  const store = storeOf(moved)

  // stored coords are local to the group (origin 100,50)
  expect({ x: store['shape:a'].x, y: store['shape:a'].y }).toEqual({ x: 100, y: 150 })
  // but Claude sees the absolute page coord it asked for
  expect(snapshotToCards(moved).find((c) => c.id === 'shape:a')).toMatchObject({ x: 200, y: 200 })
})

test('move_cards on a loose card is unchanged (page coords written directly)', () => {
  const moved = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 7, y: 8 }] }))!
  expect({ x: storeOf(moved)['shape:a'].x, y: storeOf(moved)['shape:a'].y }).toEqual({ x: 7, y: 8 })
})

test('ungroup_cards with an unknown group id is a no-op', () => {
  const out = applyChangeSetToSnapshot(twoCardSnapshot(), cs({ kind: 'ungroup_cards', groupId: 'shape:nope' }))!
  expect(snapshotToCards(out).find((c) => c.id === 'shape:a')).toMatchObject({ x: 100, y: 50 })
})
