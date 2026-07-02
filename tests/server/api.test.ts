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
  expect((await request(app).get('/projects/ghost/cards')).status).toBe(404)
  expect((await request(app).post('/projects/ghost/canvas').send({ document: null })).status).toBe(404)
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
