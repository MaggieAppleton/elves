import { expect, test } from 'vitest'
import { snapshotToCards } from '../../server/digest'
import { resolveAssetPath } from '../../server/assets'

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
    { id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'my point', x: 10, y: 20, comments: [], mergedInto: null, assetPath: null },
  ])
})

test('snapshotToCards returns [] for an empty canvas', () => {
  expect(snapshotToCards({ document: null, session: null })).toEqual([])
})

test('snapshotToCards resolves assetPath for image cards when given an assets dir', () => {
  const snapshot = {
    document: { store: { 'shape:i': {
      id: 'shape:i', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 280, h: 200, kind: 'source', sourceKind: 'image', origin: 'image', text: '', comments: [], mergedInto: null, assetId: 'pic.png' },
    } } },
    session: null,
  }
  const [card] = snapshotToCards(snapshot, '/assets')
  expect(card.assetPath).toBe(resolveAssetPath('/assets', 'pic.png'))
  expect(snapshotToCards(snapshot)[0].assetPath).toBeNull() // no assetsDir → null
})
