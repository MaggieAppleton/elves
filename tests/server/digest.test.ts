import { expect, test } from 'vitest'
import { snapshotToCards } from '../../server/digest'

test('snapshotToCards projects card shapes into a clean digest', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
        },
        'shape:b': {
          id: 'shape:b', typeName: 'shape', type: 'geo', x: 0, y: 0, props: {},
        },
        'page:p': { id: 'page:p', typeName: 'page' },
      },
    },
    session: null,
  }
  expect(snapshotToCards(snapshot)).toEqual([
    { id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'my point', x: 10, y: 20, comments: [], mergedInto: null },
  ])
})

test('snapshotToCards returns [] for an empty canvas', () => {
  expect(snapshotToCards({ document: null, session: null })).toEqual([])
})
