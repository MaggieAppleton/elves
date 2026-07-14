import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { createProject, canvasPathFor } from '../../server/projects'
import { readCanvas } from '../../server/store'
import {
  SERVER_CANVAS_METADATA_KEY,
  ensureCanvasMetadata,
} from '../../server/canvasMetadata'

const REVISION_HEADER = 'x-elves-canvas-revision'
let roots: string[] = []

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'elves-revision-v2-'))
  roots.push(root)
  await createProject(root, 'Essay', '2026-07-13T00:00:00.000Z')
  return { root, app: createServer(root) }
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
  roots = []
})

function snapshot(session: unknown = null) {
  return {
    document: {
      store: {
        'page:page': { id: 'page:page', typeName: 'page' },
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
          parentId: 'page:page',
          props: {
            w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'transcribed',
            text: 'A', authoredBy: 'claude', comments: [], mergedInto: null,
          },
        },
      },
    },
    session,
  }
}

async function seed(root: string, value: Record<string, unknown> = snapshot()): Promise<string> {
  const path = canvasPathFor(root, 'essay')!
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8')
  return path
}

async function bytes(path: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

test('v2 canvas read lazily persists one epoch without advancing revision or sequence', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const first = await request(app).get('/projects/essay/canvas?protocol=2')
  expect(first.status).toBe(200)
  expect(first.body).toMatchObject({
    snapshot: snapshot(),
    revision: 0,
    pendingChangeSets: [],
    nextChangeSetToken: { epoch: expect.stringMatching(/^[0-9a-f-]{36}$/), sequence: 0 },
  })
  expect(first.body.snapshot).not.toHaveProperty(SERVER_CANVAS_METADATA_KEY)
  const stored = await readCanvas(path) as any
  expect(stored[SERVER_CANVAS_METADATA_KEY].epoch).toBe(first.body.nextChangeSetToken.epoch)

  const afterRestart = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(afterRestart.body.nextChangeSetToken).toEqual(first.body.nextChangeSetToken)
  expect(afterRestart.body.revision).toBe(0)
  const legacy = await request(createServer(root)).get('/projects/essay/canvas')
  expect(legacy.body).not.toHaveProperty(SERVER_CANVAS_METADATA_KEY)
})

test('versioned save requires the revision header without mutating disk', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  await request(app).get('/projects/essay/canvas?protocol=2')
  const before = await bytes(path)
  const response = await request(app).post('/projects/essay/canvas?protocol=2').send(snapshot('new'))
  expect(response.status).toBe(400)
  expect(response.body).toMatchObject({ code: 'canvas-revision-required' })
  expect(await bytes(path)).toEqual(before)
})

test('versioned save rejects every non-canonical revision spelling without mutation', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  await request(app).get('/projects/essay/canvas?protocol=2')
  const before = await bytes(path)
  for (const header of [' ', '0x0', '0e0', '+0', '0.0', '00', '-1', '9007199254740992']) {
    const response = await request(app)
      .post('/projects/essay/canvas?protocol=2')
      .set(REVISION_HEADER, header)
      .send(snapshot(header))
    expect(response.status, header).toBe(400)
    expect(response.body).toMatchObject({ code: 'invalid-canvas-revision' })
    expect(await bytes(path)).toEqual(before)
  }
})

test('a current versioned save strips forged metadata and preserves server token state', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  const incoming = {
    ...snapshot({ browser: true }),
    [SERVER_CANVAS_METADATA_KEY]: { revision: 999, epoch: 'forged', nextSequence: 999 },
  }
  const saved = await request(app)
    .post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0')
    .send(incoming)
  expect(saved.status).toBe(200)
  expect(saved.body).toEqual({ ok: true, revision: 1 })
  const stored = await readCanvas(path) as any
  expect(stored.session).toEqual({ browser: true })
  expect(stored[SERVER_CANVAS_METADATA_KEY]).toMatchObject({
    revision: 1,
    epoch: loaded.body.nextChangeSetToken.epoch,
    nextSequence: 0,
  })
})

test('two saves from one revision serialize to one success and one conflict', async () => {
  const { root, app } = await setup()
  await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  const responses = await Promise.all([
    request(app).post('/projects/essay/canvas?protocol=2')
      .set(REVISION_HEADER, String(loaded.body.revision)).send(snapshot({ writer: 'a' })),
    request(app).post('/projects/essay/canvas?protocol=2')
      .set(REVISION_HEADER, String(loaded.body.revision)).send(snapshot({ writer: 'b' })),
  ])
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  expect(responses.find((response) => response.status === 409)!.body)
    .toMatchObject({ code: 'canvas-revision-conflict', revision: 1 })
})

test('a stale save leaves canvas, backup, and summary scheduling untouched', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  await request(app).get('/projects/essay/canvas?protocol=2')
  await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0').send(snapshot({ accepted: true }))
  const beforeCanvas = await bytes(path)
  const beforeBackup = await bytes(`${path}.bak`)
  const summarize = vi.fn(async () => null)
  const guarded = createServer(root, undefined, {
    summarizer: { label: 'test', summarize }, debounceMs: 1,
  })
  const stale = await request(guarded).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0').send(snapshot({ stale: true }))
  expect(stale.status).toBe(409)
  expect(stale.body).toMatchObject({ code: 'canvas-revision-conflict', revision: 1 })
  expect(await bytes(path)).toEqual(beforeCanvas)
  expect(await bytes(`${path}.bak`)).toEqual(beforeBackup)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(summarize).not.toHaveBeenCalled()
})

test('legacy snapshot save preserves the token watermark while advancing revision', async () => {
  const { root, app } = await setup()
  await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  const changeSet = {
    id: 'before-legacy-save', author: 'claude',
    ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 25, y: 0 }] }],
  }
  await request(app).post('/projects/essay/changeset?protocol=2').send({
    token: loaded.body.nextChangeSetToken,
    changeSet,
  })
  const beforeLegacy = await request(app).get('/projects/essay/canvas?protocol=2')
  expect(beforeLegacy.body.nextChangeSetToken.sequence).toBe(1)
  const saved = await request(app).post('/projects/essay/canvas').send(snapshot({ legacy: true }))
  expect(saved.status).toBe(200)
  const after = await request(app).get('/projects/essay/canvas?protocol=2')
  expect(after.body.revision).toBe(2)
  expect(after.body.nextChangeSetToken).toEqual(beforeLegacy.body.nextChangeSetToken)
})

test('versioned clear writes a revisioned tombstone and rotates epoch across restart', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  const cleared = await request(app).delete('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, String(loaded.body.revision))
  expect(cleared.status).toBe(200)
  expect(cleared.body).toEqual({ ok: true, revision: 1 })
  expect(await bytes(path)).not.toBeNull()
  expect(await bytes(`${path}.bak`)).not.toBeNull()
  const stored = await readCanvas(path) as any
  expect(stored.document).toBeNull()
  expect(stored[SERVER_CANVAS_METADATA_KEY]).toMatchObject({ revision: 1, nextSequence: 0 })
  expect(stored[SERVER_CANVAS_METADATA_KEY].epoch).not.toBe(loaded.body.nextChangeSetToken.epoch)
  const restarted = await request(createServer(root)).get('/projects/essay/changeset-token')
  expect(restarted.body).toEqual({
    revision: 1,
    token: { epoch: stored[SERVER_CANVAS_METADATA_KEY].epoch, sequence: 0 },
  })
})

test('legacy clear keeps its response while atomically persisting a backed-up tombstone', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  const move = {
    id: 'before-legacy-clear', author: 'claude',
    ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x: 25, y: 0 }] }],
  }
  await request(app).post('/projects/essay/changeset?protocol=2').send({
    token: loaded.body.nextChangeSetToken,
    changeSet: move,
  })
  const before = await readCanvas(path) as any
  expect(before[SERVER_CANVAS_METADATA_KEY]).toMatchObject({ revision: 1, nextSequence: 1 })

  const cleared = await request(app).delete('/projects/essay/canvas')
  expect(cleared.status).toBe(200)
  expect(cleared.body).toEqual({ ok: true })
  const stored = await readCanvas(path) as any
  expect(stored.document).toBeNull()
  expect(stored[SERVER_CANVAS_METADATA_KEY]).toMatchObject({ revision: 2, nextSequence: 0 })
  expect(stored[SERVER_CANVAS_METADATA_KEY].epoch).not.toBe(loaded.body.nextChangeSetToken.epoch)
  const backup = await readCanvas(`${path}.bak`) as any
  expect(backup.document).toEqual(before.document)
  expect(backup[SERVER_CANVAS_METADATA_KEY]).toEqual(before[SERVER_CANVAS_METADATA_KEY])
})

test('legacy clear tombstone rejects the old epoch and revision zero after restart', async () => {
  const { root, app } = await setup()
  await seed(root)
  const loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  await request(app).delete('/projects/essay/canvas')
  const restarted = createServer(root)

  const oldToken = await request(restarted).post('/projects/essay/changeset?protocol=2').send({
    token: loaded.body.nextChangeSetToken,
    changeSet: {
      id: 'old-token', author: 'claude',
      ops: [{ kind: 'create_note_card', text: 'must not queue', x: 0, y: 0 }],
    },
  })
  expect(oldToken.status).toBe(409)
  expect(oldToken.body).toMatchObject({ code: 'epoch-mismatch', revision: 1 })

  const oldRevision = await request(restarted).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0').send(snapshot({ stale: true }))
  expect(oldRevision.status).toBe(409)
  expect(oldRevision.body).toMatchObject({ code: 'canvas-revision-conflict', revision: 1 })
})

test('legacy clear of a missing canvas durably records revision one', async () => {
  const { root, app } = await setup()
  const path = canvasPathFor(root, 'essay')!
  expect(await bytes(path)).toBeNull()
  const cleared = await request(app).delete('/projects/essay/canvas')
  expect(cleared.status).toBe(200)
  expect(cleared.body).toEqual({ ok: true })
  expect(await bytes(path)).not.toBeNull()
  const stored = await readCanvas(path) as any
  expect(stored).toMatchObject({
    document: null,
    session: null,
    [SERVER_CANVAS_METADATA_KEY]: { revision: 1, nextSequence: 0 },
  })
})

test('stale versioned clear leaves main and backup bytes untouched', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  await request(app).get('/projects/essay/canvas?protocol=2')
  await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0').send(snapshot({ accepted: true }))
  const beforeCanvas = await bytes(path)
  const beforeBackup = await bytes(`${path}.bak`)
  const stale = await request(app).delete('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '0')
  expect(stale.status).toBe(409)
  expect(stale.body).toMatchObject({ code: 'canvas-revision-conflict', revision: 1 })
  expect(await bytes(path)).toEqual(beforeCanvas)
  expect(await bytes(`${path}.bak`)).toEqual(beforeBackup)
})

test('versioned clear requires one canonical revision header without mutation', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  await request(app).get('/projects/essay/canvas?protocol=2')
  const before = await bytes(path)
  const missing = await request(app).delete('/projects/essay/canvas?protocol=2')
  expect(missing.status).toBe(400)
  expect(missing.body).toMatchObject({ code: 'canvas-revision-required' })
  const malformed = await request(app).delete('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '00')
  expect(malformed.status).toBe(400)
  expect(malformed.body).toMatchObject({ code: 'invalid-canvas-revision' })
  expect(await bytes(path)).toEqual(before)
})

test('save and clear report revision exhaustion without mutation', async () => {
  const { root, app } = await setup()
  const exhausted = ensureCanvasMetadata(snapshot()).snapshot as any
  exhausted[SERVER_CANVAS_METADATA_KEY].revision = Number.MAX_SAFE_INTEGER
  const path = await seed(root, exhausted)
  const beforeCanvas = await bytes(path)
  const beforeBackup = await bytes(`${path}.bak`)
  const save = await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, String(Number.MAX_SAFE_INTEGER)).send(snapshot({ rejected: 'save' }))
  const clear = await request(app).delete('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, String(Number.MAX_SAFE_INTEGER))
  for (const response of [save, clear]) {
    expect(response.status).toBe(507)
    expect(response.body).toMatchObject({
      code: 'canvas-revision-exhausted', revision: Number.MAX_SAFE_INTEGER,
    })
  }
  expect(await bytes(path)).toEqual(beforeCanvas)
  expect(await bytes(`${path}.bak`)).toEqual(beforeBackup)
})

test('unknown project precedence remains 404 before versioned header validation', async () => {
  const { app } = await setup()
  const response = await request(app).post('/projects/ghost/canvas?protocol=2').send(snapshot())
  expect(response.status).toBe(404)
})
