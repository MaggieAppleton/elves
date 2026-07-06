import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'

let dirs: string[] = []
async function appWithTmp() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  return createServer(d)
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

// A minimal card shape record for canvas fixtures; override props as needed.
function mk(
  id: string, kind: 'prose' | 'note', x: number, y: number, text: string,
  props: Record<string, unknown> = {},
) {
  return {
    id, typeName: 'shape', type: 'card', x, y,
    props: {
      w: 240, h: 120, kind, noteKind: null, origin: null, text,
      comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null, ...props,
    },
  }
}

test('projects start empty, then create + list', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects')).body).toEqual([])
  const created = await request(app).post('/projects').send({ name: 'Essay' })
  expect(created.status).toBe(200)
  expect(created.body).toMatchObject({ id: 'essay', name: 'Essay' })
  expect(typeof created.body.createdAt).toBe('string')
  const list = await request(app).get('/projects')
  expect(list.body).toHaveLength(1)
  expect(list.body[0]).toMatchObject({ id: 'essay', name: 'Essay' })
})

test('rename updates the display name, keeps the id', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Draft' })
  const r = await request(app).patch('/projects/draft').send({ name: 'Final' })
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ id: 'draft', name: 'Final' })
})

test('rename of an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).patch('/projects/ghost').send({ name: 'X' })).status).toBe(404)
})

test('GET canvas returns empty before anything is saved', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const res = await request(app).get('/projects/essay/canvas')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ document: null, session: null })
})

test('POST then GET round-trips the snapshot within a project', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  const post = await request(app).post('/projects/essay/canvas').send(snap)
  expect(post.body).toEqual({ ok: true })
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual(snap)
})

test('two projects keep separate canvases', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'One' })
  await request(app).post('/projects').send({ name: 'Two' })
  await request(app).post('/projects/one/canvas').send({ document: { n: 1 }, session: null })
  await request(app).post('/projects/two/canvas').send({ document: { n: 2 }, session: null })
  expect((await request(app).get('/projects/one/canvas')).body.document).toEqual({ n: 1 })
  expect((await request(app).get('/projects/two/canvas')).body.document).toEqual({ n: 2 })
})

test('scoped routes on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects/ghost/canvas')).status).toBe(404)
  expect((await request(app).get('/projects/ghost/map')).status).toBe(404)
  expect((await request(app).get('/projects/ghost/draft')).status).toBe(404)
  expect((await request(app).post('/projects/ghost/cards').send({ ids: [] })).status).toBe(404)
  expect((await request(app).post('/projects/ghost/canvas').send({ document: null })).status).toBe(404)
})

test('GET /draft compiles the canvas into ordered narrative blocks', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // Two sections (Origins left, Turn right) with a card each, plus an opening
  // card left of both. Cards are placed so that reading order can only be right
  // if bands + within-band y ordering are honored (not a raw x scan).
  const snap = {
    document: {
      store: {
        'shape:intro': mk('shape:intro', 'prose', -400, 0, 'An opening thought.'),
        'shape:o1': mk('shape:o1', 'prose', 60, 300, 'Origins, lower.'),
        'shape:o2': mk('shape:o2', 'prose', 200, 0, 'Origins, upper.'),
        'shape:t1': mk('shape:t1', 'prose', 1060, 0, 'The turn.'),
        'shape:excluded': mk('shape:excluded', 'prose', 60, 600, 'left out', { draftExcluded: true }),
        'shape:sOrigins': { id: 'shape:sOrigins', typeName: 'shape', type: 'section', x: 0, y: -100, props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' } },
        'shape:sTurn': { id: 'shape:sTurn', typeName: 'shape', type: 'section', x: 1000, y: -100, props: { w: 320, h: 72, text: 'The turn', authoredBy: 'claude' } },
      },
    },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)
  const res = await request(app).get('/projects/essay/draft')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({
    blocks: [
      { section: null, cards: [{ id: 'shape:intro', text: 'An opening thought.' }] },
      { section: 'Origins', cards: [
        { id: 'shape:o2', text: 'Origins, upper.' }, // upper first, though further right
        { id: 'shape:o1', text: 'Origins, lower.' },
      ] },
      { section: 'The turn', cards: [{ id: 'shape:t1', text: 'The turn.' }] },
    ],
  })
})

test('a traversal-shaped id is rejected as unknown (404)', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects/..%2f..%2fetc/canvas')).status).toBe(404)
})

test('POST /projects rejects a blank or missing name', async () => {
  const app = await appWithTmp()
  expect((await request(app).post('/projects').send({ name: '' })).status).toBe(400)
  expect((await request(app).post('/projects').send({})).status).toBe(400)
})

test('POST canvas rejects a non-object body', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  expect((await request(app).post('/projects/essay/canvas').send([1, 2, 3])).status).toBe(400)
})

test('POST canvas refuses to blank a non-empty canvas (409), leaving it intact', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  await request(app).post('/projects/essay/canvas').send(snap)
  // An empty save over a real document is refused...
  const res = await request(app).post('/projects/essay/canvas').send({ document: null, session: null })
  expect(res.status).toBe(409)
  // ...and the real canvas is untouched.
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual(snap)
})

test('POST canvas allows an empty save when the canvas is still empty', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // Nothing saved yet → an empty snapshot is harmless and accepted.
  const res = await request(app).post('/projects/essay/canvas').send({ document: null, session: null })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
})

test('DELETE canvas clears an existing canvas back to empty', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  await request(app).post('/projects/essay/canvas').send(snap)
  const del = await request(app).delete('/projects/essay/canvas')
  expect(del.status).toBe(200)
  expect(del.body).toEqual({ ok: true })
  // Cleared → reads back as empty; a fresh save is then accepted again.
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual({ document: null, session: null })
  expect((await request(app).post('/projects/essay/canvas').send(snap)).status).toBe(200)
})

test('DELETE canvas on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).delete('/projects/ghost/canvas')).status).toBe(404)
})

test('unfurl requires a valid http(s) url', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  expect((await request(app).post('/projects/essay/unfurl').send({})).status).toBe(400)
  expect((await request(app).post('/projects/essay/unfurl').send({ url: 'ftp://x' })).status).toBe(400)
})

test('unfurl on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).post('/projects/ghost/unfurl').send({ url: 'https://x.com' })).status).toBe(404)
})

test('unfurl degrades to a minimal reference when the page cannot be fetched', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // A .invalid host fails DNS immediately — exercises the graceful fallback with
  // no real outbound request.
  const res = await request(app).post('/projects/essay/unfurl').send({ url: 'https://elves.invalid/paper' })
  expect(res.status).toBe(200)
  expect(res.body.reference).toMatchObject({
    url: 'https://elves.invalid/paper', fetchedBy: 'unfurl', title: null,
  })
}, 15000)

test('a write failure returns 500 instead of crashing the server', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  const app = createServer(d)
  await request(app).post('/projects').send({ name: 'Essay' })
  // Force writeCanvas to fail deterministically while the project still resolves:
  // make canvas.json a DIRECTORY, so the atomic rename onto it throws. Without an
  // error boundary the rejected promise is fatal; with one, we get a clean 500.
  await fs.mkdir(join(d, 'projects', 'essay', 'canvas.json'))
  const res = await request(app)
    .post('/projects/essay/canvas')
    .send({ document: null, session: null })
  expect(res.status).toBe(500)
}, 10000)
