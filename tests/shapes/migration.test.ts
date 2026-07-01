import { expect, test } from 'vitest'
import { addCommentsUp, addAssetIdUp } from '../../src/shapes/CardShapeUtil'

test('migration adds comments[] and mergedInto to a pre-Phase-2 card', () => {
  const oldProps: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi',
  }
  addCommentsUp(oldProps)
  expect(oldProps.comments).toEqual([])
  expect(oldProps.mergedInto).toBeNull()
})

test('AddAssetId migration adds assetId to a pre-image card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null,
  }
  addAssetIdUp(props)
  expect(props.assetId).toBeNull()
})
