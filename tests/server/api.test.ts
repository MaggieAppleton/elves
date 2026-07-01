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
  return createServer(join(d, 'canvas.json'))
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('GET /canvas returns an empty canvas before anything is saved', async () => {
  const app = await appWithTmp()
  const res = await request(app).get('/canvas')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ document: null, session: null })
})

test('POST then GET round-trips the snapshot', async () => {
  const app = await appWithTmp()
  const snap = { document: { schema: 1, records: [] }, session: null }
  const post = await request(app).post('/canvas').send(snap)
  expect(post.status).toBe(200)
  expect(post.body).toEqual({ ok: true })
  const get = await request(app).get('/canvas')
  expect(get.body).toEqual(snap)
})

test('POST rejects a non-object body', async () => {
  const app = await appWithTmp()
  const res = await request(app).post('/canvas').send([1, 2, 3])
  expect(res.status).toBe(400)
})

test('a write failure returns 500 instead of crashing the server', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  // Force writeCanvas to fail deterministically: make the data path's parent a
  // FILE, so mkdir(dirname(path)) throws ENOTDIR. Without an error boundary the
  // rejected promise is fatal; with one, the request should get a clean 500.
  const filePath = join(d, 'not-a-dir')
  await fs.writeFile(filePath, 'x', 'utf8')
  const app = createServer(join(filePath, 'canvas.json'))
  const res = await request(app)
    .post('/canvas')
    .send({ document: null, session: null })
  expect(res.status).toBe(500)
}, 10000)
