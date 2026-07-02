import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createServer } from '../../server/app'
import { attachRealtime } from '../../server/realtime'
import { createProject } from '../../server/projects'
import {
  makeChangeSet,
  addCommentTool,
  readCanvasTool,
  createSourceCardTool,
  listProjectsTool,
} from '../../mcp/tools'

let servers: http.Server[] = []
let dirs: string[] = []
async function liveElves(): Promise<{ base: string }> {
  const dataRoot = await fs.mkdtemp(join(tmpdir(), 'elves-mcp-'))
  dirs.push(dataRoot)
  await createProject(dataRoot, 'Essay', '2026-07-02T10:00:00.000Z') // id: 'essay'
  const httpServer = http.createServer()
  const { broadcast } = attachRealtime(httpServer)
  const app = createServer(dataRoot, broadcast)
  httpServer.on('request', app)
  await new Promise<void>((r) => httpServer.listen(0, r))
  servers.push(httpServer)
  const { port } = httpServer.address() as import('node:net').AddressInfo
  return { base: `http://localhost:${port}` }
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

async function seedCard(base: string, id: string) {
  const snap = {
    document: { store: { [id]: { id, typeName: 'shape', type: 'card', x: 1, y: 2, props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi', comments: [], mergedInto: null } } } },
    session: null,
  }
  await fetch(`${base}/projects/essay/canvas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snap),
  })
}

test('makeChangeSet stamps author claude and a string id', () => {
  const cs = makeChangeSet([{ kind: 'move_cards', moves: [] }])
  expect(cs.author).toBe('claude')
  expect(typeof cs.id).toBe('string')
  expect(cs.ops).toEqual([{ kind: 'move_cards', moves: [] }])
})

test('listProjectsTool returns the project id and name', async () => {
  const { base } = await liveElves()
  expect(await listProjectsTool(base)).toEqual([{ id: 'essay', name: 'Essay' }])
})

test('addCommentTool posts a change-set the server broadcasts tagged with the project', async () => {
  const { base } = await liveElves()
  await seedCard(base, 'shape:a')
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await addCommentTool(base, 'essay', { cardId: 'shape:a', text: 'no source', type: 'needs-evidence' })

  const { projectId, changeSet } = await received
  expect(projectId).toBe('essay')
  expect(changeSet.author).toBe('claude')
  expect(changeSet.ops).toEqual([
    { kind: 'add_comment', cardId: 'shape:a', comment: { type: 'needs-evidence', text: 'no source' } },
  ])
  ws.close()
})

test('createSourceCardTool posts a create_source_card change-set', async () => {
  const { base } = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await createSourceCardTool(base, 'essay', { text: 'typed handwriting', x: 5, y: 6 })

  const { projectId, changeSet } = await received
  expect(projectId).toBe('essay')
  expect(changeSet.ops).toEqual([{ kind: 'create_source_card', text: 'typed handwriting', x: 5, y: 6 }])
  ws.close()
})

test('readCanvasTool reads the card digest for the project', async () => {
  const { base } = await liveElves()
  await seedCard(base, 'shape:a')
  const cards = await readCanvasTool(base, 'essay')
  expect(cards).toEqual([
    { id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'hi', x: 1, y: 2, comments: [], mergedInto: null, assetPath: null },
  ])
})

test('a tool call for an unknown project rejects with a helpful error', async () => {
  const { base } = await liveElves()
  await expect(readCanvasTool(base, 'ghost')).rejects.toThrow(/unknown project/)
})
