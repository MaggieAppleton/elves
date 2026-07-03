import { expect, test } from 'vitest'
import {
  snapshotToCards,
  snapshotToSections,
  snapshotToCanvasDigest,
  snapshotToCardMap,
  snapshotToCardsById,
  snapshotToSummarizableCards,
} from '../../server/digest'
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
    { id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'my point', x: 10, y: 20, comments: [], mergedInto: null, assetPath: null, reference: null, summary: null },
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

test('snapshotToCards passes a reference card\'s structured metadata through to the digest', () => {
  const reference = {
    url: 'https://arxiv.org/abs/2501.00001', refType: 'paper', title: 'Task-Driven Data Models',
    authors: ['Ruanqianqian Cao', 'Yuan Jiang'], siteName: 'arxiv.org', year: 2025, venue: 'CHI 2025',
    description: null, faviconAssetId: 'fav.ico', thumbnailAssetId: null, doi: null,
    arxivId: '2501.00001', fetchedBy: 'claude', fetchedAt: '2026-07-02T00:00:00.000Z',
  }
  const snapshot = {
    document: { store: { 'shape:r': {
      id: 'shape:r', typeName: 'shape', type: 'card', x: 3, y: 4,
      props: { w: 260, h: 116, kind: 'source', sourceKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: null, assetId: null, reference },
    } } },
    session: null,
  }
  const [card] = snapshotToCards(snapshot)
  expect(card.sourceKind).toBe('reference')
  expect(card.reference).toEqual(reference)
})

test('snapshotToSections projects section shapes into a clean digest, ignoring cards', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
        },
        'shape:s': {
          id: 'shape:s', typeName: 'shape', type: 'section', x: 5, y: 6,
          props: { w: 320, h: 72, text: 'Origins', authoredBy: 'claude' },
        },
      },
    },
    session: null,
  }
  expect(snapshotToSections(snapshot)).toEqual([
    { id: 'shape:s', text: 'Origins', x: 5, y: 6, authoredBy: 'claude' },
  ])
})

test('snapshotToSections returns [] for an empty canvas', () => {
  expect(snapshotToSections({ document: null, session: null })).toEqual([])
})

const LONG = 'A '.repeat(150) + 'end' // > SUMMARY_MIN_CHARS

function mapSnapshot() {
  return {
    document: {
      store: {
        'shape:short': {
          id: 'shape:short', typeName: 'shape', type: 'card', x: 0, y: 0,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'a short point', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
        'shape:long': {
          id: 'shape:long', typeName: 'shape', type: 'card', x: 30, y: 0,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: LONG, comments: [{ id: 'c', type: null, text: 'note', resolved: false, author: 'claude' }], mergedInto: null, assetId: null, reference: null, summary: 'a model gist', summaryOfHash: 'abc', summaryBy: 'ollama/llama3.2', summaryAt: '2026-07-03T00:00:00.000Z' },
        },
        'shape:s': {
          id: 'shape:s', typeName: 'shape', type: 'section', x: 5, y: 6,
          props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' },
        },
      },
    },
    session: null,
  }
}

test('snapshotToCards carries a card\'s stored summary through to the digest', () => {
  const [, long] = snapshotToCards(mapSnapshot())
  expect(long.summary).toBe('a model gist')
})

test('snapshotToCardMap gives a gist per card and no full text', () => {
  const map = snapshotToCardMap(mapSnapshot())
  expect(map.cards).toEqual([
    // short card: its own (short) text is the gist
    { id: 'shape:short', kind: 'prose', sourceKind: null, x: 0, y: 0, gist: 'a short point', textLen: 13 },
    // long card: the model summary is the gist; comments/text are NOT included
    { id: 'shape:long', kind: 'prose', sourceKind: null, x: 30, y: 0, gist: 'a model gist', textLen: LONG.length },
  ])
  expect(map.sections).toEqual([{ id: 'shape:s', text: 'Origins', x: 5, y: 6, authoredBy: 'user' }])
  // No entry leaks the full text or comment bodies.
  expect(JSON.stringify(map.cards)).not.toContain('note')
})

test('snapshotToCardMap falls back to a mechanical gist when a long card has no summary', () => {
  const snap = mapSnapshot() as any
  snap.document.store['shape:long'].props.summary = null
  const map = snapshotToCardMap(snap)
  const long = map.cards.find((c) => c.id === 'shape:long')!
  expect(long.gist.length).toBeLessThan(LONG.length) // truncated, not the whole thing
  expect(long.gist.endsWith('…') || long.gist.length <= 121).toBe(true)
})

test('snapshotToCardMap includes mergedInto and refType only when set', () => {
  const snap = {
    document: { store: {
      'shape:r': {
        id: 'shape:r', typeName: 'shape', type: 'card', x: 1, y: 1,
        props: { w: 260, h: 116, kind: 'source', sourceKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: 'shape:rep', assetId: null, reference: { url: 'u', refType: 'paper', title: 'T', authors: [], siteName: null, year: null, venue: null, description: null, faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null, fetchedBy: null, fetchedAt: null }, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
      },
    } },
    session: null,
  }
  const [entry] = snapshotToCardMap(snap).cards
  expect(entry.mergedInto).toBe('shape:rep')
  expect(entry.refType).toBe('paper')
})

test('snapshotToCardsById returns full digests only for the requested ids', () => {
  const cards = snapshotToCardsById(mapSnapshot(), ['shape:long'])
  expect(cards).toHaveLength(1)
  expect(cards[0].id).toBe('shape:long')
  expect(cards[0].text).toBe(LONG) // full text present in the drill-down
  expect(cards[0].comments).toHaveLength(1)
})

test('snapshotToSummarizableCards exposes just the summary decision fields', () => {
  expect(snapshotToSummarizableCards(mapSnapshot())).toEqual([
    { id: 'shape:short', kind: 'prose', sourceKind: null, text: 'a short point', summary: null, summaryOfHash: null },
    { id: 'shape:long', kind: 'prose', sourceKind: null, text: LONG, summary: 'a model gist', summaryOfHash: 'abc' },
  ])
})

test('snapshotToCanvasDigest combines cards and sections', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
        },
        'shape:s': {
          id: 'shape:s', typeName: 'shape', type: 'section', x: 5, y: 6,
          props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' },
        },
      },
    },
    session: null,
  }
  expect(snapshotToCanvasDigest(snapshot)).toEqual({
    cards: snapshotToCards(snapshot),
    sections: snapshotToSections(snapshot),
  })
})
