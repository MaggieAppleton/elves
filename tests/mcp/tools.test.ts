import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createServer } from '../../server/app'
import { attachRealtime } from '../../server/realtime'
import { makeChangeSet, addCommentTool, moveCardsTool, mergeSourcesTool, readCanvasTool } from '../../mcp/tools'

let servers: http.Server[] = []
async function liveElves(): Promise<string> {
  const httpServer = http.createServer()
  const { broadcast } = attachRealtime(httpServer)
  const app = createServer(process.env.ELVES_CANVAS ?? '/tmp/elves-mcp-test-canvas.json', broadcast)
  httpServer.on('request', app)
  await new Promise<void>((r) => httpServer.listen(0, r))
  servers.push(httpServer)
  const { port } = httpServer.address() as import('node:net').AddressInfo
  return `http://localhost:${port}`
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
})

test('makeChangeSet stamps author claude and a string id', () => {
  const cs = makeChangeSet([{ kind: 'move_cards', moves: [] }])
  expect(cs.author).toBe('claude')
  expect(typeof cs.id).toBe('string')
  expect(cs.ops).toEqual([{ kind: 'move_cards', moves: [] }])
})

test('addCommentTool posts a valid change-set that the server broadcasts', async () => {
  const base = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await addCommentTool(base, { cardId: 'shape:a', text: 'no source', type: 'needs-evidence' })

  const cs = await received
  expect(cs.author).toBe('claude')
  expect(cs.ops).toEqual([{ kind: 'add_comment', cardId: 'shape:a', comment: { type: 'needs-evidence', text: 'no source' } }])
  ws.close()
})

test('readCanvasTool reads the card digest', async () => {
  const base = await liveElves()
  const snap = { document: { store: { 'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 1, y: 2, props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi', comments: [], mergedInto: null } } } }, session: null }
  await fetch(`${base}/canvas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap) })
  const cards = await readCanvasTool(base)
  expect(cards).toEqual([{ id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'hi', x: 1, y: 2, comments: [], mergedInto: null }])
})
