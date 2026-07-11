import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { createSelectionStore, enrichSelection } from '../../server/selection'
import type { CardMap } from '../../server/digest'

// --- createSelectionStore (the in-memory global slot) -----------------------

test('the store starts empty and records the last selection reported', () => {
  const store = createSelectionStore()
  expect(store.get()).toBeNull()
  store.set('essay', ['shape:a', 'shape:b'], '2026-07-08T00:00:00.000Z')
  expect(store.get()).toEqual({
    projectId: 'essay',
    shapeIds: ['shape:a', 'shape:b'],
    selectedAt: '2026-07-08T00:00:00.000Z',
  })
})

test('a later report replaces the earlier one (last tab wins)', () => {
  const store = createSelectionStore()
  store.set('essay', ['shape:a'], '2026-07-08T00:00:00.000Z')
  store.set('notes', ['shape:z'], '2026-07-08T00:00:01.000Z')
  expect(store.get()).toEqual({
    projectId: 'notes',
    shapeIds: ['shape:z'],
    selectedAt: '2026-07-08T00:00:01.000Z',
  })
})

test('an empty report records a deselection, not a no-op', () => {
  const store = createSelectionStore()
  store.set('essay', ['shape:a'], '2026-07-08T00:00:00.000Z')
  store.set('essay', [], '2026-07-08T00:00:02.000Z')
  expect(store.get()?.shapeIds).toEqual([])
})

// --- enrichSelection (ids → typed, gisted entries) --------------------------

const MAP: CardMap = {
  cards: [
    { id: 'shape:c', kind: 'note', noteKind: null, x: 0, y: 0, w: 1, h: 1, gist: 'compost ratios', textLen: 13 },
    { id: 'shape:p', kind: 'prose', noteKind: null, x: 1, y: 0, w: 1, h: 1, gist: 'the bed layout', textLen: 14 },
  ],
  sections: [{ id: 'shape:s', text: 'Soil prep', x: 0, y: 0, authoredBy: 'user' }],
  questions: [{ id: 'shape:q', text: 'How deep?', x: 0, y: 0, authoredBy: 'claude', dismissed: false }],
  groups: [{ id: 'shape:g', cardIds: ['shape:c', 'shape:p'], memberCount: 2, bounds: { x: 0, y: 0, w: 2, h: 1 } }],
}

test('enrichSelection reports each shape type with the right fields', () => {
  expect(enrichSelection(MAP, ['shape:c', 'shape:s', 'shape:q', 'shape:g'])).toEqual([
    { id: 'shape:c', type: 'card', kind: 'note', gist: 'compost ratios' },
    { id: 'shape:s', type: 'section', text: 'Soil prep' },
    { id: 'shape:q', type: 'question', text: 'How deep?' },
    { id: 'shape:g', type: 'group', memberCount: 2 },
  ])
})

test('enrichSelection preserves the order the user selected in', () => {
  const out = enrichSelection(MAP, ['shape:p', 'shape:c'])
  expect(out.map((s) => s.id)).toEqual(['shape:p', 'shape:c'])
})

test('enrichSelection drops ids no longer on the canvas (deleted since selecting)', () => {
  expect(enrichSelection(MAP, ['shape:c', 'shape:gone'])).toEqual([
    { id: 'shape:c', type: 'card', kind: 'note', gist: 'compost ratios' },
  ])
})

// --- HTTP round-trip: POST /selection → GET /selection ----------------------

let dirs: string[] = []
async function appWithSelection() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-selection-'))
  dirs.push(d)
  return createServer(d, undefined, undefined, undefined, createSelectionStore())
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

// A canvas holding one prose card, one section, one question, and a group of two
// note cards — one of each thing the map (and thus the selection) can surface.
const CANVAS = {
  document: {
    store: {
      'page:p': { id: 'page:p', typeName: 'page' },
      'shape:card': {
        id: 'shape:card', typeName: 'shape', type: 'card', parentId: 'page:p', x: 10, y: 0,
        props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'the bed layout matters', comments: [], mergedInto: null },
      },
      'shape:sec': {
        id: 'shape:sec', typeName: 'shape', type: 'section', parentId: 'page:p', x: 0, y: 0,
        props: { w: 300, h: 40, text: 'Soil prep', authoredBy: 'user' },
      },
      'shape:q': {
        id: 'shape:q', typeName: 'shape', type: 'question', parentId: 'page:p', x: 0, y: 0,
        props: { w: 200, h: 80, text: 'How deep should the beds be?', authoredBy: 'claude', dismissed: false },
      },
      'shape:grp': { id: 'shape:grp', typeName: 'shape', type: 'group', parentId: 'page:p', x: 0, y: 0, props: {} },
      'shape:m1': {
        id: 'shape:m1', typeName: 'shape', type: 'card', parentId: 'shape:grp', x: 0, y: 200,
        props: { w: 240, h: 120, kind: 'note', noteKind: null, origin: null, text: 'compost 3:1', comments: [], mergedInto: null },
      },
      'shape:m2': {
        id: 'shape:m2', typeName: 'shape', type: 'card', parentId: 'shape:grp', x: 250, y: 200,
        props: { w: 240, h: 120, kind: 'note', noteKind: null, origin: null, text: 'water weekly', comments: [], mergedInto: null },
      },
    },
  },
  session: null,
}

async function seed(app: Awaited<ReturnType<typeof appWithSelection>>) {
  await request(app).post('/projects').send({ name: 'Garden' })
  await request(app).post('/projects/garden/canvas').send(CANVAS)
}

test('GET /selection returns an empty list before anything is reported', async () => {
  const app = await appWithSelection()
  const res = await request(app).get('/selection')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ selection: [] })
})

test('a reported selection comes back enriched with project, gists, and a timestamp', async () => {
  const app = await appWithSelection()
  await seed(app)
  const post = await request(app)
    .post('/projects/garden/selection')
    .send({ shapeIds: ['shape:card', 'shape:sec', 'shape:q', 'shape:grp'] })
  expect(post.status).toBe(200)

  const res = await request(app).get('/selection')
  expect(res.status).toBe(200)
  expect(res.body.project).toBe('garden')
  expect(typeof res.body.selectedAt).toBe('string')
  expect(res.body.selection).toEqual([
    { id: 'shape:card', type: 'card', kind: 'prose', gist: 'the bed layout matters' },
    { id: 'shape:sec', type: 'section', text: 'Soil prep' },
    { id: 'shape:q', type: 'question', text: 'How deep should the beds be?' },
    { id: 'shape:grp', type: 'group', memberCount: 2 },
  ])
})

test('ids deleted since selecting are dropped from the result', async () => {
  const app = await appWithSelection()
  await seed(app)
  await request(app).post('/projects/garden/selection').send({ shapeIds: ['shape:card', 'shape:ghost'] })
  const res = await request(app).get('/selection')
  expect(res.body.selection.map((s: { id: string }) => s.id)).toEqual(['shape:card'])
})

test('GET /selection returns empty if the selected project was renamed away', async () => {
  const app = await appWithSelection()
  await seed(app)
  await request(app).post('/projects/garden/selection').send({ shapeIds: ['shape:card'] })
  await request(app).patch('/projects/garden').send({ name: 'Orchard' })
  const res = await request(app).get('/selection')
  expect(res.body).toEqual({ selection: [] })
})

test('POST /selection rejects a non-string-array body', async () => {
  const app = await appWithSelection()
  await seed(app)
  const res = await request(app).post('/projects/garden/selection').send({ shapeIds: 'shape:card' })
  expect(res.status).toBe(400)
})

test('POST /selection 404s for an unknown project', async () => {
  const app = await appWithSelection()
  const res = await request(app).post('/projects/nope/selection').send({ shapeIds: [] })
  expect(res.status).toBe(404)
})
