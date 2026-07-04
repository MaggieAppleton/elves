import { expect, test } from 'vitest'
import {
  snapshotToCards,
  snapshotToSections,
  snapshotToCanvasDigest,
  snapshotToCardMap,
  snapshotToCardsById,
  snapshotToSummarizableCards,
  snapshotToGroups,
  resolvePageXY,
} from '../../server/digest'
import { resolveAssetPath } from '../../server/assets'

test('snapshotToCards projects card shapes into a clean digest', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
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
    { id: 'shape:a', kind: 'prose', noteKind: null, origin: null, text: 'my point', x: 10, y: 20, comments: [], mergedInto: null, assetPath: null, reference: null, figureTitle: '', figureStatus: null, summary: null },
  ])
})

test('snapshotToCards returns [] for an empty canvas', () => {
  expect(snapshotToCards({ document: null, session: null })).toEqual([])
})

test('snapshotToCards resolves assetPath for image cards when given an assets dir', () => {
  const snapshot = {
    document: { store: { 'shape:i': {
      id: 'shape:i', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 280, h: 200, kind: 'note', noteKind: 'image', origin: 'image', text: '', comments: [], mergedInto: null, assetId: 'pic.png' },
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
      props: { w: 260, h: 116, kind: 'note', noteKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: null, assetId: null, reference },
    } } },
    session: null,
  }
  const [card] = snapshotToCards(snapshot)
  expect(card.noteKind).toBe('reference')
  expect(card.reference).toEqual(reference)
})

test('snapshotToCards exposes a figure card\'s title and status, description in text', () => {
  const snapshot = {
    document: { store: { 'shape:f': {
      id: 'shape:f', typeName: 'shape', type: 'card', x: 7, y: 8,
      props: {
        w: 260, h: 148, kind: 'figure', noteKind: null, origin: null,
        text: 'a horizontal rigid → malleable axis', comments: [], mergedInto: null,
        assetId: null, reference: null, figureTitle: 'Malleability spectrum', figureStatus: 'sketched',
      },
    } } },
    session: null,
  }
  const [card] = snapshotToCards(snapshot)
  expect(card.kind).toBe('figure')
  expect(card.figureTitle).toBe('Malleability spectrum')
  expect(card.figureStatus).toBe('sketched')
  expect(card.text).toBe('a horizontal rigid → malleable axis')
})

test('the map shows a figure by its title as gist, plus its status', () => {
  const snapshot = {
    document: { store: { 'shape:f': {
      id: 'shape:f', typeName: 'shape', type: 'card', x: 7, y: 8,
      props: {
        w: 260, h: 148, kind: 'figure', noteKind: null, origin: null,
        text: 'a long description of the visual '.repeat(6), comments: [], mergedInto: null,
        assetId: null, reference: null, figureTitle: 'Malleability spectrum', figureStatus: 'idea',
      },
    } } },
    session: null,
  }
  const [entry] = snapshotToCardMap(snapshot).cards
  expect(entry.kind).toBe('figure')
  expect(entry.gist).toBe('Malleability spectrum') // the title is the gist, not a truncated description
  expect(entry.figureStatus).toBe('idea')
})

test('snapshotToSections projects section shapes into a clean digest, ignoring cards', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
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

const LONG = 'A '.repeat(150) + 'end' // a long card body

function mapSnapshot() {
  return {
    document: {
      store: {
        'shape:short': {
          id: 'shape:short', typeName: 'shape', type: 'card', x: 0, y: 0,
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'a short point', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
        'shape:long': {
          id: 'shape:long', typeName: 'shape', type: 'card', x: 30, y: 0,
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: LONG, comments: [{ id: 'c', type: null, text: 'a buried comment', resolved: false, author: 'claude' }], mergedInto: null, assetId: null, reference: null, summary: 'a model gist', summaryOfHash: 'abc', summaryBy: 'ollama/llama3.2', summaryAt: '2026-07-03T00:00:00.000Z' },
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
    // short card: its own (short) text is the gist. w/h are the real footprint,
    // so Claude can place new cards clear of it.
    { id: 'shape:short', kind: 'prose', noteKind: null, x: 0, y: 0, w: 240, h: 120, gist: 'a short point', textLen: 13 },
    // long card: the model summary is the gist; comments/text are NOT included
    { id: 'shape:long', kind: 'prose', noteKind: null, x: 30, y: 0, w: 240, h: 120, gist: 'a model gist', textLen: LONG.length },
  ])
  expect(map.sections).toEqual([{ id: 'shape:s', text: 'Origins', x: 5, y: 6, authoredBy: 'user' }])
  // No entry leaks the full text or comment bodies.
  expect(JSON.stringify(map.cards)).not.toContain('buried comment')
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
        props: { w: 260, h: 116, kind: 'note', noteKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: 'shape:rep', assetId: null, reference: { url: 'u', refType: 'paper', title: 'T', authors: [], siteName: null, year: null, venue: null, description: null, faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null, fetchedBy: null, fetchedAt: null }, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
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
    { id: 'shape:short', kind: 'prose', noteKind: null, text: 'a short point', summary: null, summaryOfHash: null },
    { id: 'shape:long', kind: 'prose', noteKind: null, text: LONG, summary: 'a model gist', summaryOfHash: 'abc' },
  ])
})

// A canvas with two grouped cards (A, B) and one ungrouped card (C).
// The group's origin is the top-left of the members' page bounds; each member's
// stored x/y is group-LOCAL, so page coords must be resolved through the group.
function groupedSnapshot() {
  return {
    document: {
      store: {
        'page:p': { id: 'page:p', typeName: 'page' },
        'shape:g': {
          id: 'shape:g', typeName: 'shape', type: 'group', x: 100, y: 50,
          parentId: 'page:p', props: {},
        },
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0, parentId: 'shape:g',
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'note', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
        'shape:b': {
          id: 'shape:b', typeName: 'shape', type: 'card', x: 30, y: 10, parentId: 'shape:g',
          props: { w: 240, h: 120, kind: 'note', noteKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
        'shape:c': {
          id: 'shape:c', typeName: 'shape', type: 'card', x: 500, y: 500, parentId: 'page:p',
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'alone', comments: [], mergedInto: null, assetId: null, reference: null, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        },
      },
    },
    session: null,
  }
}

test('resolvePageXY returns page coords for top-level, grouped, and nested shapes', () => {
  const snap = groupedSnapshot()
  const store = snap.document.store as Record<string, any>
  expect(resolvePageXY(store, store['shape:c'])).toEqual({ x: 500, y: 500 }) // top-level
  expect(resolvePageXY(store, store['shape:a'])).toEqual({ x: 100, y: 50 })  // group origin
  expect(resolvePageXY(store, store['shape:b'])).toEqual({ x: 130, y: 60 })  // origin + local
  // nested: a group inside a group
  const nested = {
    'page:p': { id: 'page:p', typeName: 'page' },
    'shape:outer': { id: 'shape:outer', typeName: 'shape', type: 'group', x: 10, y: 10, parentId: 'page:p', props: {} },
    'shape:inner': { id: 'shape:inner', typeName: 'shape', type: 'group', x: 5, y: 5, parentId: 'shape:outer', props: {} },
    'shape:deep': { id: 'shape:deep', typeName: 'shape', type: 'card', x: 2, y: 3, parentId: 'shape:inner', props: { w: 240, h: 120 } },
  } as Record<string, any>
  expect(resolvePageXY(nested, nested['shape:deep'])).toEqual({ x: 17, y: 18 })
})

test('snapshotToCards resolves grouped cards to PAGE coords', () => {
  const cards = snapshotToCards(groupedSnapshot())
  expect(cards.find((c) => c.id === 'shape:a')).toMatchObject({ x: 100, y: 50 })
  expect(cards.find((c) => c.id === 'shape:b')).toMatchObject({ x: 130, y: 60 })
  expect(cards.find((c) => c.id === 'shape:c')).toMatchObject({ x: 500, y: 500 })
})

test('snapshotToCardMap tags grouped cards with groupId and leaves loose cards untagged', () => {
  const map = snapshotToCardMap(groupedSnapshot())
  expect(map.cards.find((c) => c.id === 'shape:a')!.groupId).toBe('shape:g')
  expect(map.cards.find((c) => c.id === 'shape:b')!.groupId).toBe('shape:g')
  expect(map.cards.find((c) => c.id === 'shape:c')!).not.toHaveProperty('groupId')
})

test('snapshotToGroups reports members and the union of their page bounds', () => {
  expect(snapshotToGroups(groupedSnapshot())).toEqual([
    { id: 'shape:g', cardIds: ['shape:a', 'shape:b'], memberCount: 2, bounds: { x: 100, y: 50, w: 270, h: 130 } },
  ])
})

test('snapshotToCardMap has an empty groups[] when nothing is grouped', () => {
  expect(snapshotToCardMap(mapSnapshot()).groups).toEqual([])
})

test('snapshotToGroups drops a group with no card members', () => {
  const snap = groupedSnapshot() as any
  snap.document.store['shape:a'].parentId = 'page:p'
  snap.document.store['shape:b'].parentId = 'page:p'
  expect(snapshotToGroups(snap)).toEqual([])
})

test('snapshotToCanvasDigest combines cards and sections', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
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
