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
import { createProject, assetsDirFor } from '../../server/projects'

let dirs: string[] = []
async function root() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-cs-'))
  dirs.push(d)
  return d
}
async function rootWithProject() {
  const d = await root()
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

// create_source_card references no existing card, so it passes the cross-check
// without seeding a canvas.
const csCreate = {
  id: 'x',
  author: 'claude',
  ops: [{ kind: 'create_source_card', text: 'hi', x: 1, y: 2 }],
}

function cardSnapshot(id: string) {
  return {
    document: {
      store: {
        [id]: {
          id,
          typeName: 'shape',
          type: 'card',
          x: 0,
          y: 0,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi', comments: [], mergedInto: null },
        },
      },
    },
    session: null,
  }
}

test('POST changeset validates and forwards to onChangeSet with the project id', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  const ok = await request(app).post('/projects/essay/changeset').send(csCreate)
  expect(ok.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith('essay', csCreate)

  const bad = await request(app).post('/projects/essay/changeset').send({ id: 'x', ops: 'nope' })
  expect(bad.status).toBe(400)
  expect(onChangeSet).toHaveBeenCalledTimes(1)
})

test('changeset on an unknown project → 404', async () => {
  const d = await root()
  const app = createServer(d)
  expect((await request(app).post('/projects/ghost/changeset').send(csCreate)).status).toBe(404)
})

test('changeset referencing a card not in the project → 409', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  const move = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:missing', x: 1, y: 2 }] }] }
  const res = await request(app).post('/projects/essay/changeset').send(move)
  expect(res.status).toBe(409)
  expect(res.body.missing).toEqual(['shape:missing'])
  expect(onChangeSet).not.toHaveBeenCalled()
})

test('changeset referencing an existing card is accepted', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const move = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 9, y: 9 }] }] }
  const res = await request(app).post('/projects/essay/changeset').send(move)
  expect(res.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith('essay', move)
})

test('a move_cards change-set persists to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d) // no onChangeSet listener == no browser connected
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const move = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 9, y: 9 }] }] }
  expect((await request(app).post('/projects/essay/changeset').send(move)).status).toBe(200)

  const cards = await request(app).get('/projects/essay/cards')
  expect(cards.body[0]).toMatchObject({ x: 9, y: 9 })
})

test('an add_comment change-set persists to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const cs = {
    id: 'x', author: 'claude',
    ops: [{ kind: 'add_comment', cardId: 'shape:a', comment: { type: null, text: 'needs a source' } }],
  }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const cards = await request(app).get('/projects/essay/cards')
  expect(cards.body[0].comments).toEqual([
    expect.objectContaining({ text: 'needs a source', author: 'claude', resolved: false }),
  ])
})

test('a merge_sources change-set persists mergedInto to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const snap = {
    document: {
      store: {
        'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0, props: { w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'a', comments: [], mergedInto: null } },
        'shape:b': { id: 'shape:b', typeName: 'shape', type: 'card', x: 0, y: 0, props: { w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'b', comments: [], mergedInto: null } },
      },
    },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'merge_sources', cardIds: ['shape:a', 'shape:b'] }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const cards = await request(app).get('/projects/essay/cards')
  const byId = Object.fromEntries(cards.body.map((c: any) => [c.id, c]))
  expect(byId['shape:b'].mergedInto).toBe('shape:a')
  expect(byId['shape:a'].mergedInto).toBeNull()
})

test('a create_source_card change-set persists a new card when the project already has a canvas', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'create_source_card', text: 'new note', x: 5, y: 6 }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const cards = await request(app).get('/projects/essay/cards')
  expect(cards.body).toHaveLength(2)
  expect(cards.body.find((c: any) => c.text === 'new note')).toMatchObject({ x: 5, y: 6, kind: 'source' })
})

test('create_source_card on a project with no canvas yet falls back to broadcast-only (no crash)', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  const res = await request(app).post('/projects/essay/changeset').send(csCreate)
  expect(res.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith('essay', csCreate)
  expect((await request(app).get('/projects/essay/cards')).body).toEqual([])
})

test('two changesets targeting different projects both land on disk with no browser connected', async () => {
  const d = await root()
  await createProject(d, 'Essay A', '2026-07-02T10:00:00.000Z')
  await createProject(d, 'Essay B', '2026-07-02T10:00:01.000Z')
  const app = createServer(d) // simulates the reported bug: nobody's browser has either project open
  await request(app).post('/projects/essay-a/canvas').send(cardSnapshot('shape:a'))
  await request(app).post('/projects/essay-b/canvas').send(cardSnapshot('shape:b'))

  const moveA = { id: 'a', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 1, y: 1 }] }] }
  const commentB = { id: 'b', author: 'claude', ops: [{ kind: 'add_comment', cardId: 'shape:b', comment: { type: null, text: 'hi' } }] }
  const [resA, resB] = await Promise.all([
    request(app).post('/projects/essay-a/changeset').send(moveA),
    request(app).post('/projects/essay-b/changeset').send(commentB),
  ])
  expect(resA.status).toBe(200)
  expect(resB.status).toBe(200)

  const cardsA = await request(app).get('/projects/essay-a/cards')
  const cardsB = await request(app).get('/projects/essay-b/cards')
  expect(cardsA.body[0]).toMatchObject({ x: 1, y: 1 })
  expect(cardsB.body[0].comments).toHaveLength(1)
})

test('a change-set that would write text is rejected (400 for unknown kind)', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const bad = { id: 'x', author: 'claude', ops: [{ kind: 'edit_text', cardId: 'a', text: 'no' }] }
  expect((await request(app).post('/projects/essay/changeset').send(bad)).status).toBe(400)
})

test('attachRealtime broadcasts a tagged change-set to websocket clients', async () => {
  const server = http.createServer()
  const { broadcast } = attachRealtime(server)
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo

  const ws = new WebSocket(`ws://localhost:${port}/ws`)
  const received = new Promise<any>((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  broadcast('essay', csCreate as any)
  expect(await received).toEqual({ projectId: 'essay', changeSet: csCreate })

  ws.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('GET cards returns the card digest for the project', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const snap = {
    document: { store: { 'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 5, y: 6, props: { w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'raw', comments: [], mergedInto: null } } } },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)
  const res = await request(app).get('/projects/essay/cards')
  expect(res.status).toBe(200)
  expect(res.body).toEqual(snapshotToCards(snap, assetsDirFor(d, 'essay')!))
})

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('POST assets stores an image and GET serves it, scoped to the project', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const post = await request(app).post('/projects/essay/assets').set('content-type', 'image/png').send(TINY_PNG)
  expect(post.status).toBe(200)
  expect(post.body.assetId).toMatch(/\.png$/)

  const get = await request(app).get(`/projects/essay/assets/${post.body.assetId}`)
  expect(get.status).toBe(200)
  expect(get.headers['content-type']).toContain('image/png')

  const bytes = await request(app)
    .get(`/projects/essay/assets/${post.body.assetId}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  expect(bytes.body).toEqual(TINY_PNG)
})

test('POST assets rejects a non-image body', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const res = await request(app).post('/projects/essay/assets').set('content-type', 'text/plain').send('nope')
  expect(res.status).toBe(400)
})

test('GET assets rejects a traversal id', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const res = await request(app).get('/projects/essay/assets/..%2fpackage.json')
  expect([400, 404]).toContain(res.status)
})
