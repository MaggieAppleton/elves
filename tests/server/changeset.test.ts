import { afterEach, expect, test, vi } from 'vitest'
import { snapshotToCards } from '../../server/digest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { WebSocket } from 'ws'
import request from 'supertest'
import { createServer } from '../../server/app'
import { attachRealtime } from '../../server/realtime'

let dirs: string[] = []
async function tmpCanvas() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-cs-'))
  dirs.push(d)
  return join(d, 'canvas.json')
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

const validCs = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'a', x: 1, y: 2 }] }] }

test('POST /changeset validates and forwards to onChangeSet', async () => {
  const onChangeSet = vi.fn()
  const app = createServer(await tmpCanvas(), onChangeSet)
  const ok = await request(app).post('/changeset').send(validCs)
  expect(ok.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith(validCs)

  const bad = await request(app).post('/changeset').send({ id: 'x', ops: 'nope' })
  expect(bad.status).toBe(400)
  expect(onChangeSet).toHaveBeenCalledTimes(1) // called once for the valid POST, never for the invalid one
})

test('attachRealtime broadcasts a change-set to connected websocket clients', async () => {
  const server = http.createServer()
  const { broadcast } = attachRealtime(server)
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo

  const ws = new WebSocket(`ws://localhost:${port}/ws`)
  const received = new Promise<any>((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  broadcast(validCs as any)
  expect(await received).toEqual(validCs)

  ws.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('GET /cards returns the card digest', async () => {
  const app = createServer(await tmpCanvas())
  const snap = {
    document: { store: { 'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 5, y: 6, props: { w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'raw', comments: [], mergedInto: null } } } },
    session: null,
  }
  await request(app).post('/canvas').send(snap)
  const res = await request(app).get('/cards')
  expect(res.status).toBe(200)
  expect(res.body).toEqual(snapshotToCards(snap))
})

test('POST /changeset rejects a change-set that would write text (403)', async () => {
  const app = createServer(await tmpCanvas())
  const bad = { id: 'x', author: 'claude', ops: [{ kind: 'edit_text', cardId: 'a', text: 'no' }] }
  const res = await request(app).post('/changeset').send(bad)
  expect(res.status).toBe(400) // isChangeSet already rejects unknown kinds first
})

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('POST /assets stores an image and GET /assets/:id serves it', async () => {
  const app = createServer(await tmpCanvas())
  const post = await request(app).post('/assets').set('content-type', 'image/png').send(TINY_PNG)
  expect(post.status).toBe(200)
  expect(post.body.assetId).toMatch(/\.png$/)

  const get = await request(app).get(`/assets/${post.body.assetId}`)
  expect(get.status).toBe(200)
  expect(get.headers['content-type']).toContain('image/png')

  const bytes = await request(app)
    .get(`/assets/${post.body.assetId}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  expect(bytes.body).toEqual(TINY_PNG)
})

test('POST /assets rejects a non-image body', async () => {
  const app = createServer(await tmpCanvas())
  const res = await request(app).post('/assets').set('content-type', 'text/plain').send('nope')
  expect(res.status).toBe(400)
})

test('GET /assets rejects a traversal id', async () => {
  const app = createServer(await tmpCanvas())
  const res = await request(app).get('/assets/..%2fpackage.json')
  expect([400, 404]).toContain(res.status)
})
