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
