import { afterEach, expect, test, vi } from 'vitest'
import { snapshotToCards } from '../../server/digest'
import { applyChangeSetToSnapshot } from '../../server/applyChangeSet'
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

// create_note_card references no existing card, so it passes the cross-check
// without seeding a canvas.
const csCreate = {
  id: 'x',
  author: 'claude',
  ops: [{ kind: 'create_note_card', text: 'hi', x: 1, y: 2 }],
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
          props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'hi', comments: [], mergedInto: null },
        },
      },
    },
    session: null,
  }
}

function sectionSnapshot(id: string) {
  return {
    document: {
      store: {
        [id]: {
          id,
          typeName: 'shape',
          type: 'section',
          x: 0,
          y: 0,
          props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' },
        },
      },
    },
    session: null,
  }
}

// The old GET /canvas-digest was replaced by GET /map (cheap, no full text) +
// POST /cards (full digests by id). This rebuilds the equivalent { cards,
// sections } shape those persistence assertions expect, exercising both.
async function fullDigest(app: any, project: string) {
  const map = await request(app).get(`/projects/${project}/map`)
  const ids = (map.body.cards ?? []).map((c: any) => c.id)
  const cards = ids.length
    ? (await request(app).post(`/projects/${project}/cards`).send({ ids })).body.cards
    : []
  return { status: map.status, body: { cards, sections: map.body.sections } }
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

test('changeset referencing a section not in the project → 409', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  const rename = { id: 'x', author: 'claude', ops: [{ kind: 'edit_section_text', sectionId: 'shape:missing', text: 'nope' }] }
  const res = await request(app).post('/projects/essay/changeset').send(rename)
  expect(res.status).toBe(409)
  expect(res.body.missing).toEqual(['shape:missing'])
  expect(onChangeSet).not.toHaveBeenCalled()
})

test('changeset referencing an existing section is accepted', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  await request(app).post('/projects/essay/canvas').send(sectionSnapshot('shape:s'))
  const rename = { id: 'x', author: 'claude', ops: [{ kind: 'edit_section_text', sectionId: 'shape:s', text: 'The turn' }] }
  const res = await request(app).post('/projects/essay/changeset').send(rename)
  expect(res.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith('essay', rename)
})

test('a move_cards change-set persists to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d) // no onChangeSet listener == no browser connected
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const move = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 9, y: 9 }] }] }
  expect((await request(app).post('/projects/essay/changeset').send(move)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.cards[0]).toMatchObject({ x: 9, y: 9 })
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

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.cards[0].comments).toEqual([
    expect.objectContaining({ text: 'needs a source', author: 'claude', resolved: false }),
  ])
})

test('a merge_notes change-set persists mergedInto to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const snap = {
    document: {
      store: {
        'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0, props: { w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'typed', text: 'a', comments: [], mergedInto: null } },
        'shape:b': { id: 'shape:b', typeName: 'shape', type: 'card', x: 0, y: 0, props: { w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'typed', text: 'b', comments: [], mergedInto: null } },
      },
    },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'merge_notes', cardIds: ['shape:a', 'shape:b'] }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  const byId = Object.fromEntries(digest.body.cards.map((c: any) => [c.id, c]))
  expect(byId['shape:b'].mergedInto).toBe('shape:a')
  expect(byId['shape:a'].mergedInto).toBeNull()
})

test('applyChangeSetToSnapshot stamps the change-set author onto the created note card', () => {
  // The persisted card must remember which agent authored it, so a reload still
  // shows the authorship mark. Use a non-Claude author to prove it is the
  // change-set's author that lands, not a hardcoded value.
  const snap = {
    document: { store: { 'page:page': { id: 'page:page', typeName: 'page' } } },
    session: null,
  } as any
  const cs = { id: 'x', author: 'openai', ops: [{ kind: 'create_note_card' as const, text: 'hi', x: 1, y: 2 }] }
  const next = applyChangeSetToSnapshot(snap, cs) as any
  const created = Object.values(next.document.store).find(
    (r: any) => r?.typeName === 'shape' && r.type === 'card',
  ) as any
  expect(created.props.authoredBy).toBe('openai')
})

test('applyChangeSetToSnapshot persists a figure card with title, description-as-text, status, and author', () => {
  const snap = {
    document: { store: { 'page:page': { id: 'page:page', typeName: 'page' } } },
    session: null,
  } as any
  const cs = {
    id: 'x', author: 'openai',
    ops: [{ kind: 'create_figure_card' as const, title: 'Spectrum', description: 'rigid → malleable axis', x: 1, y: 2 }],
  }
  const next = applyChangeSetToSnapshot(snap, cs) as any
  const created = Object.values(next.document.store).find(
    (r: any) => r?.typeName === 'shape' && r.type === 'card',
  ) as any
  expect(created.props.kind).toBe('figure')
  expect(created.props.figureTitle).toBe('Spectrum')
  expect(created.props.text).toBe('rigid → malleable axis')
  expect(created.props.figureStatus).toBe('idea')
  expect(created.props.authoredBy).toBe('openai')
})

test('a create_figure_card change-set persists a figure and the map shows its title + status', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const cs = {
    id: 'x', author: 'claude',
    ops: [{ kind: 'create_figure_card', title: 'Timeline', description: 'the sequence of releases', x: 400, y: 0 }],
  }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const map = await request(app).get('/projects/essay/map')
  const figure = map.body.cards.find((c: any) => c.kind === 'figure')
  expect(figure).toMatchObject({ kind: 'figure', gist: 'Timeline', figureStatus: 'idea' })
})

test('a create_note_card change-set persists a new card when the project already has a canvas', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  // (5,6) sits on top of shape:a (0,0, 240x120), so the placement guard slides
  // the new card straight down clear of it — same x, y past shape:a's bottom.
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'create_note_card', text: 'new note', x: 5, y: 6 }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.cards).toHaveLength(2)
  expect(digest.body.cards.find((c: any) => c.text === 'new note')).toMatchObject({ x: 5, y: 144, kind: 'note' })
})

test('the placement guard leaves a clear position untouched and slides an overlapping one down', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a')) // (0,0), 240x120

  // A spot well to the right of shape:a is clear → placed exactly as asked.
  const clear = { id: 'c', author: 'claude', ops: [{ kind: 'create_note_card', text: 'clear', x: 400, y: 0 }] }
  expect((await request(app).post('/projects/essay/changeset').send(clear)).status).toBe(200)
  // A spot on top of shape:a → slid down past its bottom (120) + gap (24) = 144.
  const onTop = { id: 'o', author: 'claude', ops: [{ kind: 'create_note_card', text: 'on top', x: 10, y: 10 }] }
  expect((await request(app).post('/projects/essay/changeset').send(onTop)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  const byText = Object.fromEntries(digest.body.cards.map((c: any) => [c.text, c]))
  expect(byText['clear']).toMatchObject({ x: 400, y: 0 })
  expect(byText['on top']).toMatchObject({ x: 10, y: 144 })
})

// A two-card canvas used to prove grouping survives the full HTTP → persist →
// reload → map path with no browser connected.
function twoCardCanvas() {
  return {
    document: {
      store: {
        'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 100, y: 50, parentId: 'page:page', props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'note', comments: [], mergedInto: null } },
        'shape:b': { id: 'shape:b', typeName: 'shape', type: 'card', x: 130, y: 60, parentId: 'page:page', props: { w: 240, h: 120, kind: 'note', noteKind: 'reference', origin: 'reference', text: '', comments: [], mergedInto: null } },
        'page:page': { id: 'page:page', typeName: 'page' },
      },
    },
    session: null,
  }
}

test('a group_cards change-set persists to disk and the map shows the binding with page coords', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(twoCardCanvas())
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'group_cards', cardIds: ['shape:a', 'shape:b'] }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const map = await request(app).get('/projects/essay/map')
  expect(map.body.groups).toEqual([
    { id: expect.any(String), cardIds: ['shape:a', 'shape:b'], memberCount: 2, bounds: { x: 100, y: 50, w: 270, h: 130 } },
  ])
  const groupId = map.body.groups[0].id
  // grouped cards report their PAGE coords + the groupId, despite being stored group-local
  expect(map.body.cards.find((c: any) => c.id === 'shape:a')).toMatchObject({ x: 100, y: 50, groupId })
  expect(map.body.cards.find((c: any) => c.id === 'shape:b')).toMatchObject({ x: 130, y: 60, groupId })

  // ungroup dissolves the binding, cards keep their page positions
  const ungroup = { id: 'y', author: 'claude', ops: [{ kind: 'ungroup_cards', groupId }] }
  expect((await request(app).post('/projects/essay/changeset').send(ungroup)).status).toBe(200)
  const after = await request(app).get('/projects/essay/map')
  expect(after.body.groups).toEqual([])
  expect(after.body.cards.find((c: any) => c.id === 'shape:a')).toMatchObject({ x: 100, y: 50 })
  expect(after.body.cards.find((c: any) => c.id === 'shape:a')).not.toHaveProperty('groupId')
})

test('create_note_card on a project with no canvas yet falls back to broadcast-only (no crash)', async () => {
  const d = await rootWithProject()
  const onChangeSet = vi.fn()
  const app = createServer(d, onChangeSet)
  const res = await request(app).post('/projects/essay/changeset').send(csCreate)
  expect(res.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith('essay', csCreate)
  expect((await fullDigest(app, 'essay')).body.cards).toEqual([])
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

  const digestA = await fullDigest(app, 'essay-a')
  const digestB = await fullDigest(app, 'essay-b')
  expect(digestA.body.cards[0]).toMatchObject({ x: 1, y: 1 })
  expect(digestB.body.cards[0].comments).toHaveLength(1)
})

test('a create_section change-set persists a new section when the project already has a canvas', async () => {
  const d = await rootWithProject()
  const app = createServer(d) // no browser connected
  await request(app).post('/projects/essay/canvas').send(cardSnapshot('shape:a'))
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'create_section', text: 'Origins', x: 5, y: 6 }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.sections).toHaveLength(1)
  expect(digest.body.sections[0]).toMatchObject({ text: 'Origins', x: 5, y: 6, authoredBy: 'claude' })
})

test('a move_sections change-set persists to disk even with no browser connected', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(sectionSnapshot('shape:s'))
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'move_sections', moves: [{ sectionId: 'shape:s', x: 9, y: 9 }] }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.sections[0]).toMatchObject({ x: 9, y: 9 })
})

test('an edit_section_text change-set persists the new text and flips authoredBy to claude', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  await request(app).post('/projects/essay/canvas').send(sectionSnapshot('shape:s'))
  const cs = { id: 'x', author: 'claude', ops: [{ kind: 'edit_section_text', sectionId: 'shape:s', text: 'The turn' }] }
  expect((await request(app).post('/projects/essay/changeset').send(cs)).status).toBe(200)

  const digest = await fullDigest(app, 'essay')
  expect(digest.body.sections[0]).toMatchObject({ text: 'The turn', authoredBy: 'claude' })
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

test('GET /map returns the cheap map and POST /cards returns full digests', async () => {
  const d = await rootWithProject()
  const app = createServer(d)
  const snap = {
    document: {
      store: {
        'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 5, y: 6, props: { w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'typed', text: 'raw', comments: [], mergedInto: null } },
        'shape:s': { id: 'shape:s', typeName: 'shape', type: 'section', x: 1, y: 2, props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' } },
      },
    },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)

  // The map: a small entry per card (gist, no full text) plus sections.
  const map = await request(app).get('/projects/essay/map')
  expect(map.status).toBe(200)
  expect(map.body.cards).toEqual([
    { id: 'shape:a', kind: 'note', noteKind: 'text', x: 5, y: 6, w: 240, h: 120, gist: 'raw', textLen: 3 },
  ])
  expect(map.body.sections).toEqual([{ id: 'shape:s', text: 'Origins', x: 1, y: 2, authoredBy: 'user' }])

  // The drill-down: full digests for requested ids.
  const cards = await request(app).post('/projects/essay/cards').send({ ids: ['shape:a'] })
  expect(cards.status).toBe(200)
  expect(cards.body.cards).toEqual(snapshotToCards(snap, assetsDirFor(d, 'essay')!))

  // A bad ids payload is a 400.
  expect((await request(app).post('/projects/essay/cards').send({ ids: 'nope' })).status).toBe(400)
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
