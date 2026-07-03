import { expect, test } from 'vitest'
import { addCommentsUp, addAssetIdUp, addReferenceUp, addSummaryUp } from '../../src/shapes/CardShapeUtil'

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

test('AddReference migration adds reference to a pre-reference card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null, assetId: null,
  }
  addReferenceUp(props)
  expect(props.reference).toBeNull()
})

test('AddSummary migration adds the four null summary fields to a pre-summary card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'x',
    comments: [], mergedInto: null, assetId: null, reference: null,
  }
  addSummaryUp(props)
  expect(props).toMatchObject({
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  })
})
