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
  setAgentId,
  getAgentId,
  addCommentTool,
  readMapTool,
  readCardsTool,
  createNoteCardTool,
  createReferenceTool,
  createSectionTool,
  moveSectionsTool,
  editSectionTextTool,
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
    document: { store: { [id]: { id, typeName: 'shape', type: 'card', x: 1, y: 2, props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'hi', comments: [], mergedInto: null } } } },
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

test('the configured agent id (ELVES_AGENT) becomes the change-set author', () => {
  // Default is Claude, but another agent's MCP process configures its own id,
  // which then stamps every change-set it posts (and thus its notes' marks).
  expect(getAgentId()).toBe('claude')
  try {
    setAgentId('openai')
    expect(getAgentId()).toBe('openai')
    expect(makeChangeSet([{ kind: 'move_cards', moves: [] }]).author).toBe('openai')
  } finally {
    setAgentId('claude') // reset process-wide state so other tests see the default
  }
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

test('createNoteCardTool posts a create_note_card change-set', async () => {
  const { base } = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await createNoteCardTool(base, 'essay', { text: 'typed handwriting', x: 5, y: 6 })

  const { projectId, changeSet } = await received
  expect(projectId).toBe('essay')
  expect(changeSet.ops).toEqual([{ kind: 'create_note_card', text: 'typed handwriting', x: 5, y: 6 }])
  ws.close()
})

test('readMapTool reads the cheap map (gist, no full text) for the project', async () => {
  const { base } = await liveElves()
  await seedCard(base, 'shape:a')
  const map = await readMapTool(base, 'essay')
  expect(map).toEqual({
    cards: [{ id: 'shape:a', kind: 'prose', noteKind: null, x: 1, y: 2, gist: 'hi', textLen: 2 }],
    sections: [],
    groups: [],
  })
})

test('readCardsTool reads full digests for the requested card ids', async () => {
  const { base } = await liveElves()
  await seedCard(base, 'shape:a')
  const cards = await readCardsTool(base, 'essay', ['shape:a'])
  expect(cards).toEqual([
    { id: 'shape:a', kind: 'prose', noteKind: null, origin: null, text: 'hi', x: 1, y: 2, comments: [], mergedInto: null, assetPath: null, reference: null, summary: null },
  ])
})

test('createReferenceTool unfurls a url and posts a create_reference change-set, Claude fields winning', async () => {
  const { base } = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  // Point at the server's own JSON endpoint: unfurl fetches it, sees non-HTML,
  // and degrades to a minimal reference — no external network in the test.
  const url = `${base}/projects`
  await createReferenceTool(base, 'essay', {
    url, x: 5, y: 6,
    fields: { title: 'Malleable Software', refType: 'paper', authors: ['Cao', 'Jiang', 'Xia'], year: 2025 },
  })

  const { projectId, changeSet } = await received
  expect(projectId).toBe('essay')
  expect(changeSet.ops).toHaveLength(1)
  const op = changeSet.ops[0]
  expect(op.kind).toBe('create_reference')
  expect(op.x).toBe(5)
  expect(op.reference.url).toBe(url)
  expect(op.reference.title).toBe('Malleable Software')     // Claude field wins
  expect(op.reference.refType).toBe('paper')
  expect(op.reference.authors).toEqual(['Cao', 'Jiang', 'Xia'])
  expect(op.reference.year).toBe(2025)
  expect(op.reference.fetchedBy).toBe('claude')
  ws.close()
})

test('a tool call for an unknown project rejects with a helpful error', async () => {
  const { base } = await liveElves()
  await expect(readMapTool(base, 'ghost')).rejects.toThrow(/unknown project/)
})

test('createSectionTool posts a create_section change-set', async () => {
  const { base } = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await createSectionTool(base, 'essay', { text: 'Origins', x: 5, y: 6 })

  const { projectId, changeSet } = await received
  expect(projectId).toBe('essay')
  expect(changeSet.ops).toEqual([{ kind: 'create_section', text: 'Origins', x: 5, y: 6 }])
  ws.close()
})

async function seedSection(base: string, id: string) {
  const snap = {
    document: { store: { [id]: { id, typeName: 'shape', type: 'section', x: 1, y: 2, props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' } } } },
    session: null,
  }
  await fetch(`${base}/projects/essay/canvas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snap),
  })
}

test('moveSectionsTool posts a move_sections change-set', async () => {
  const { base } = await liveElves()
  await seedSection(base, 'shape:s')
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await moveSectionsTool(base, 'essay', { moves: [{ sectionId: 'shape:s', x: 10, y: 20 }] })

  const { changeSet } = await received
  expect(changeSet.ops).toEqual([{ kind: 'move_sections', moves: [{ sectionId: 'shape:s', x: 10, y: 20 }] }])
  ws.close()
})

test('editSectionTextTool posts an edit_section_text change-set', async () => {
  const { base } = await liveElves()
  await seedSection(base, 'shape:s')
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await editSectionTextTool(base, 'essay', { sectionId: 'shape:s', text: 'The turn' })

  const { changeSet } = await received
  expect(changeSet.ops).toEqual([{ kind: 'edit_section_text', sectionId: 'shape:s', text: 'The turn' }])
  ws.close()
})
