import { afterEach, expect, test, vi } from 'vitest'
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
