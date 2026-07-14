import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { createProject, canvasPathFor } from '../../server/projects'
import { readCanvas } from '../../server/store'
import type { ChangeSet } from '../../src/model/changeset'
import {
  MAX_PENDING_CHANGE_SETS,
  SERVER_CANVAS_METADATA_KEY,
  addPendingChangeSet,
  consumeChangeSetSequence,
  ensureCanvasMetadata,
  legacyChangeSetReceipt,
  nextChangeSetToken,
  pendingChangeSetsForClient,
} from '../../server/canvasMetadata'
import { changeSetDigest, semanticChangeSetJson } from '../../server/changeSetIdentity'
import { applyChangeSetToSnapshot } from '../../server/applyChangeSet'
import { changeSetTokenStamp } from '../../src/model/changeset'

const REVISION_HEADER = 'x-elves-canvas-revision'
let roots: string[] = []

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'elves-token-http-'))
  roots.push(root)
  await createProject(root, 'Essay', '2026-07-13T00:00:00.000Z')
  return { root, app: createServer(root) }
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
  roots = []
})

function canvas() {
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
    session: null,
  }
}

function move(id: string, x: number): ChangeSet {
  return {
    id, author: 'claude',
    ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x, y: 0 }] }],
  }
}

function create(id: string, text = id): ChangeSet {
  return { id, author: 'claude', ops: [{ kind: 'create_note_card', text, x: 1, y: 2 }] }
}

async function seed(root: string, value: Record<string, unknown> = canvas()): Promise<string> {
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

async function token(app: any) {
  return request(app).get('/projects/essay/changeset-token')
}

function tokenPost(app: any, issued: unknown, changeSet: ChangeSet) {
  return request(app).post('/projects/essay/changeset?protocol=2').send({
    token: issued,
    changeSet,
  })
}

test('lightweight token read lazily persists one stable token without reserving it', async () => {
  const { root, app } = await setup()
  const first = await token(app)
  expect(first.status).toBe(200)
  expect(first.body).toMatchObject({
    revision: 0,
    token: { epoch: expect.stringMatching(/^[0-9a-f-]{36}$/), sequence: 0 },
  })
  const restarted = await token(createServer(root))
  expect(restarted.body).toEqual(first.body)
  const stored = await readCanvas(canvasPathFor(root, 'essay')!) as any
  expect(stored[SERVER_CANVAS_METADATA_KEY]).toMatchObject({
    revision: 0, epoch: first.body.token.epoch, nextSequence: 0,
  })
})

test('direct tokenized POST initializes one durable epoch and retry uses that exact token', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const changeSet = move('direct-init', 25)
  const initialized = await tokenPost(app, { epoch: 'wrong', sequence: 0 }, changeSet)
  expect(initialized.status).toBe(409)
  expect(initialized.body).toMatchObject({
    code: 'epoch-mismatch',
    revision: 0,
    nextChangeSetToken: { epoch: expect.stringMatching(/^[0-9a-f-]{36}$/), sequence: 0 },
  })
  const advertised = initialized.body.nextChangeSetToken
  const stored = await readCanvas(path) as any
  expect(stored[SERVER_CANVAS_METADATA_KEY]).toMatchObject({
    revision: 0,
    epoch: advertised.epoch,
    nextSequence: 0,
  })
  expect(await bytes(`${path}.bak`)).not.toBeNull()

  const initializedCanvas = await bytes(path)
  const initializedBackup = await bytes(`${path}.bak`)
  const repeatedConflict = await tokenPost(app, { epoch: 'still-wrong', sequence: 0 }, changeSet)
  expect(repeatedConflict.body.nextChangeSetToken).toEqual(advertised)
  expect(await bytes(path)).toEqual(initializedCanvas)
  expect(await bytes(`${path}.bak`)).toEqual(initializedBackup)

  const retried = await tokenPost(app, advertised, changeSet)
  expect(retried.status).toBe(200)
  expect(retried.body).toMatchObject({
    revision: 1,
    nextChangeSetToken: { epoch: advertised.epoch, sequence: 1 },
  })
  expect((await readCanvas(path) as any).document.store['shape:a'].x).toBe(25)
  expect((await token(createServer(root))).body).toEqual({
    revision: 1,
    token: { epoch: advertised.epoch, sequence: 1 },
  })
})

test('direct tokenized POST can retry the initialized token into a durable queue', async () => {
  const { root, app } = await setup()
  const path = await seed(root, { document: null, session: null })
  const changeSet = create('direct-queue')
  const initialized = await tokenPost(app, { epoch: 'wrong', sequence: 0 }, changeSet)
  expect(initialized.status).toBe(409)
  const advertised = initialized.body.nextChangeSetToken

  const queued = await tokenPost(app, advertised, changeSet)
  expect(queued.status).toBe(202)
  expect(queued.body).toMatchObject({
    pending: true,
    revision: 1,
    nextChangeSetToken: { epoch: advertised.epoch, sequence: 1 },
  })
  const restarted = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(restarted.body.pendingChangeSets).toEqual([{ token: advertised, changeSet }])
  expect((await readCanvas(path) as any)[SERVER_CANVAS_METADATA_KEY].epoch).toBe(advertised.epoch)
})

test('tokenized route strictly rejects malformed token bodies without mutation', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const epoch = '00000000-0000-4000-8000-000000000000'
  const before = await bytes(path)
  const invalid = [
    undefined,
    null,
    {},
    { epoch: '', sequence: 0 },
    { epoch, sequence: '0' },
    { epoch, sequence: -1 },
    { epoch, sequence: 0.5 },
    { epoch, sequence: Number.MAX_SAFE_INTEGER + 1 },
  ]
  for (const candidate of invalid) {
    const response = await tokenPost(app, candidate, create('invalid-token'))
    expect(response.status, JSON.stringify(candidate)).toBe(400)
    expect(response.body).toMatchObject({ code: 'invalid-changeset-token' })
    expect(await bytes(path)).toEqual(before)
  }
})

test('known-project structural and Task 1 bound failures are rejected before mutation', async () => {
  const { root, app } = await setup()
  const path = await seed(root)
  const issued = (await token(app)).body.token
  const before = await bytes(path)
  const structural = await request(app).post('/projects/essay/changeset?protocol=2')
    .send({ token: issued, changeSet: { id: 'bad', ops: 'nope' } })
  expect(structural.status).toBe(400)
  expect(structural.body).toMatchObject({ code: 'invalid-change-set' })

  const tooMany: ChangeSet = {
    id: 'too-many', author: 'claude',
    ops: Array.from({ length: 513 }, () => ({ kind: 'delete_card' as const, cardId: 'shape:a' })),
  }
  const bounded = await tokenPost(app, issued, tooMany)
  expect(bounded.status).toBe(413)
  expect(bounded.body).toMatchObject({ code: 'too-many-ops' })
  expect(await bytes(path)).toEqual(before)
})

test('unknown project precedence remains 404 before token and change-set validation', async () => {
  const { app } = await setup()
  const versioned = await request(app).post('/projects/ghost/changeset?protocol=2')
    .send({ token: null, changeSet: null })
  expect(versioned.status).toBe(404)
  const legacy = await request(app).post('/projects/ghost/changeset').send({})
  expect(legacy.status).toBe(404)
})

test('accepted tokenized mutation returns and persists resulting protocol state', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const issued = (await token(app)).body.token
  const response = await tokenPost(app, issued, move('accepted', 25))
  expect(response.status).toBe(200)
  expect(response.body).toEqual({
    ok: true,
    revision: 1,
    nextChangeSetToken: { epoch: issued.epoch, sequence: 1 },
  })
  expect((await readCanvas(path) as any).document.store['shape:a'].x).toBe(25)
  expect(broadcast).toHaveBeenCalledTimes(1)
  expect((await token(app)).body).toEqual({
    revision: 1,
    token: { epoch: issued.epoch, sequence: 1 },
  })
})

test('exact tokenized retry is side-effect-free and does not broadcast or schedule summaries', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const issued = (await token(createServer(root))).body.token
  const changeSet = move('once', 25)
  await tokenPost(createServer(root), issued, changeSet)
  const beforeCanvas = await bytes(path)
  const beforeBackup = await bytes(`${path}.bak`)
  const broadcast = vi.fn()
  const summarize = vi.fn(async () => null)
  const guarded = createServer(root, broadcast, {
    summarizer: { label: 'test', summarize }, debounceMs: 1,
  })
  const retry = await tokenPost(guarded, issued, changeSet)
  expect(retry.status).toBe(200)
  expect(retry.body).toEqual({
    ok: true,
    duplicate: true,
    revision: 1,
    nextChangeSetToken: { epoch: issued.epoch, sequence: 1 },
  })
  expect(await bytes(path)).toEqual(beforeCanvas)
  expect(await bytes(`${path}.bak`)).toEqual(beforeBackup)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(broadcast).not.toHaveBeenCalled()
  expect(summarize).not.toHaveBeenCalled()
})

test('evicted consumed token maps to an unverified duplicate and never executes', async () => {
  const { root, app } = await setup()
  let state = ensureCanvasMetadata(canvas()).snapshot
  const oldToken = nextChangeSetToken(state)
  for (let sequence = 0; sequence <= 256; sequence++) {
    state = consumeChangeSetSequence(state, `retained-${sequence}`)
  }
  const path = await seed(root, state)
  const before = await bytes(path)
  const replay = await tokenPost(app, oldToken, move('evicted-replay', 99))
  expect(replay.status).toBe(200)
  expect(replay.body).toMatchObject({
    ok: true,
    duplicate: true,
    payloadUnverified: true,
    revision: 257,
    nextChangeSetToken: { epoch: oldToken.epoch, sequence: 257 },
  })
  expect(await bytes(path)).toEqual(before)
  expect((await readCanvas(path) as any).document.store['shape:a'].x).toBe(0)
})

test('wrong epoch and future sequence return current state without side effects', async () => {
  const { root } = await setup()
  const state = ensureCanvasMetadata(canvas()).snapshot
  const issued = nextChangeSetToken(state)
  const path = await seed(root, state)
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const before = await bytes(path)
  const beforeBackup = await bytes(`${path}.bak`)
  const cases = [
    [{ epoch: 'wrong', sequence: 0 }, 'epoch-mismatch'],
    [{ epoch: issued.epoch, sequence: 1 }, 'sequence-ahead'],
  ] as const
  for (const [candidate, code] of cases) {
    const response = await tokenPost(app, candidate, create(code))
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      code,
      revision: 0,
      nextChangeSetToken: issued,
    })
    expect(await bytes(path)).toEqual(before)
    expect(await bytes(`${path}.bak`)).toEqual(beforeBackup)
  }
  expect(broadcast).not.toHaveBeenCalled()
})

test('same consumed token with a different payload returns payload mismatch without mutation', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const issued = (await token(createServer(root))).body.token
  await tokenPost(createServer(root), issued, move('winner', 10))
  const before = await bytes(path)
  const broadcast = vi.fn()
  const response = await tokenPost(createServer(root, broadcast), issued, move('loser', 20))
  expect(response.status).toBe(409)
  expect(response.body).toMatchObject({
    code: 'sequence-payload-mismatch',
    revision: 1,
    nextChangeSetToken: { epoch: issued.epoch, sequence: 1 },
  })
  expect(await bytes(path)).toEqual(before)
  expect(broadcast).not.toHaveBeenCalled()
})

test('old epoch remains rejected after a versioned clear and restart', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const app = createServer(root)
  const issued = (await token(app)).body.token
  await request(app).delete('/projects/essay/canvas?protocol=2').set(REVISION_HEADER, '0')
  const before = await bytes(path)
  const response = await tokenPost(createServer(root), issued, create('old-epoch'))
  expect(response.status).toBe(409)
  expect(response.body).toMatchObject({ code: 'epoch-mismatch', revision: 1 })
  expect(await bytes(path)).toEqual(before)
})

test('tokenized revision and sequence exhaustion return 507 without mutation', async () => {
  for (const field of ['revision', 'nextSequence'] as const) {
    const { root, app } = await setup()
    const state = ensureCanvasMetadata(canvas()).snapshot as any
    state[SERVER_CANVAS_METADATA_KEY][field] = Number.MAX_SAFE_INTEGER
    const path = await seed(root, state)
    const issued = nextChangeSetToken(state)
    const before = await bytes(path)
    const response = await tokenPost(app, issued, create(`exhausted-${field}`))
    expect(response.status).toBe(507)
    expect(response.body).toMatchObject({
      code: field === 'revision' ? 'canvas-revision-exhausted' : 'changeset-sequence-exhausted',
      revision: state[SERVER_CANVAS_METADATA_KEY].revision,
      nextChangeSetToken: issued,
    })
    expect(await bytes(path)).toEqual(before)
  }
})

test('invalid target returns current protocol state and consumes nothing', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const issued = (await token(app)).body.token
  const missing: ChangeSet = {
    id: 'missing', author: 'claude', ops: [{ kind: 'delete_card', cardId: 'shape:missing' }],
  }
  const response = await tokenPost(app, issued, missing)
  expect(response.status).toBe(409)
  expect(response.body).toMatchObject({
    code: 'invalid-target',
    missing: ['shape:missing'],
    revision: 0,
    nextChangeSetToken: issued,
  })
  expect((await token(app)).body.token).toEqual(issued)
  expect(broadcast).not.toHaveBeenCalled()
  expect((await readCanvas(path) as any).document.store['shape:a']).toBeDefined()
})

test('tokenized create-only no-document work queues durably with 202 and no broadcast', async () => {
  const { root } = await setup()
  const broadcast = vi.fn()
  const summarize = vi.fn(async () => null)
  const app = createServer(root, broadcast, {
    summarizer: { label: 'test', summarize }, debounceMs: 1,
  })
  const issued = (await token(app)).body.token
  const changeSet = create('pending', 'Durable pending')
  const response = await tokenPost(app, issued, changeSet)
  expect(response.status).toBe(202)
  expect(response.body).toEqual({
    ok: true,
    pending: true,
    revision: 1,
    nextChangeSetToken: { epoch: issued.epoch, sequence: 1 },
  })
  expect(broadcast).not.toHaveBeenCalled()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(summarize).not.toHaveBeenCalled()
  const loaded = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(loaded.body.pendingChangeSets).toEqual([{ token: issued, changeSet }])
  const saved = await request(createServer(root)).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '1').send(canvas())
  expect(saved.status).toBe(200)
  const afterSave = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(afterSave.body.pendingChangeSets).toEqual([{ token: issued, changeSet }])
})

test('a versioned save atomically persists a complete stamped create and removes its pending entry', async () => {
  const { root, app } = await setup()
  const path = canvasPathFor(root, 'essay')!
  const issued = (await token(app)).body.token
  const changeSet = create('materialized', 'Materialized note')
  expect((await tokenPost(app, issued, changeSet)).status).toBe(202)
  const materialized = applyChangeSetToSnapshot(
    canvas() as never,
    changeSet,
    changeSetTokenStamp(issued),
  )!

  const saved = await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '1').send(materialized)
  expect(saved.status).toBe(200)
  expect(saved.body).toEqual({ ok: true, revision: 2 })

  const restarted = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(restarted.body.pendingChangeSets).toEqual([])
  expect(Object.values(restarted.body.snapshot.document.store)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      meta: { elvesChangeSetToken: changeSetTokenStamp(issued) },
      props: expect.objectContaining({ text: 'Materialized note' }),
    }),
  ]))

  const beforeRetry = await bytes(path)
  const staleRetry = await request(createServer(root)).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '1').send(materialized)
  expect(staleRetry.status).toBe(409)
  expect(await bytes(path)).toEqual(beforeRetry)
  expect((await request(createServer(root)).get('/projects/essay/canvas?protocol=2'))
    .body.pendingChangeSets).toEqual([])
})

test('partial and legacy materialization stay pending, and a stale complete save changes nothing', async () => {
  const { root, app } = await setup()
  const path = canvasPathFor(root, 'essay')!
  const issued = (await token(app)).body.token
  const changeSet: ChangeSet = {
    id: 'partial-materialization', author: 'claude',
    ops: [
      { kind: 'create_note_card', text: 'Note', x: 0, y: 0 },
      { kind: 'create_section', text: 'Section', x: 300, y: 0 },
    ],
  }
  expect((await tokenPost(app, issued, changeSet)).status).toBe(202)
  const complete = applyChangeSetToSnapshot(
    canvas() as never,
    changeSet,
    changeSetTokenStamp(issued),
  ) as any
  const partial = structuredClone(complete)
  const sectionId = (Object.values(partial.document.store)
    .find((record: any) => record?.type === 'section') as any)?.id
  delete partial.document.store[sectionId]

  const partialSave = await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '1').send(partial)
  expect(partialSave.status).toBe(200)
  let loaded = await request(app).get('/projects/essay/canvas?protocol=2')
  expect(loaded.body.pendingChangeSets).toEqual([{ token: issued, changeSet }])

  const beforeStale = await bytes(path)
  const stale = await request(app).post('/projects/essay/canvas?protocol=2')
    .set(REVISION_HEADER, '1').send(complete)
  expect(stale.status).toBe(409)
  expect(await bytes(path)).toEqual(beforeStale)

  const legacySave = await request(app).post('/projects/essay/canvas').send(complete)
  expect(legacySave.status).toBe(200)
  loaded = await request(createServer(root)).get('/projects/essay/canvas?protocol=2')
  expect(loaded.body.pendingChangeSets).toEqual([{ token: issued, changeSet }])
})

test('tokenized non-create no-document work returns unavailable without consuming', async () => {
  const { root, app } = await setup()
  const issued = (await token(app)).body.token
  const before = await bytes(canvasPathFor(root, 'essay')!)
  const response = await tokenPost(app, issued, { id: 'no-document', author: 'claude', ops: [] })
  expect(response.status).toBe(409)
  expect(response.body).toMatchObject({
    code: 'no-document', revision: 0, nextChangeSetToken: issued,
  })
  expect(await bytes(canvasPathFor(root, 'essay')!)).toEqual(before)
  expect((await token(app)).body.token).toEqual(issued)
})

test('pending count and aggregate limits map to stable 507 responses without consuming', async () => {
  const countSetup = await setup()
  let full = ensureCanvasMetadata({ document: null, session: null }).snapshot
  for (let index = 0; index < MAX_PENDING_CHANGE_SETS; index++) {
    const changeSet = create(`count-${index}`)
    const added = addPendingChangeSet(full, changeSet, changeSetDigest(changeSet))
    expect(added.status).toBe('added')
    if (added.status === 'added') full = added.snapshot
  }
  await seed(countSetup.root, full)
  const fullToken = nextChangeSetToken(full)
  const fullResponse = await tokenPost(countSetup.app, fullToken, create('count-overflow'))
  expect(fullResponse.status).toBe(507)
  expect(fullResponse.body).toMatchObject({
    code: 'pending-full', revision: MAX_PENDING_CHANGE_SETS, nextChangeSetToken: fullToken,
  })

  const byteSetup = await setup()
  let large = ensureCanvasMetadata({ document: null, session: null }).snapshot
  for (let index = 0; index < 4; index++) {
    const base = create(`million-${index}`, '')
    const overhead = Buffer.byteLength(semanticChangeSetJson(base), 'utf8')
    const changeSet = create(`million-${index}`, 'x'.repeat(1_000_000 - overhead))
    const added = addPendingChangeSet(large, changeSet, changeSetDigest(changeSet))
    expect(added.status).toBe('added')
    if (added.status === 'added') large = added.snapshot
  }
  await seed(byteSetup.root, large)
  const largeToken = nextChangeSetToken(large)
  const largeResponse = await tokenPost(byteSetup.app, largeToken, create('byte-overflow'))
  expect(largeResponse.status).toBe(507)
  expect(largeResponse.body).toMatchObject({
    code: 'pending-too-large', revision: 4, nextChangeSetToken: largeToken,
  })
})

test('legacy exact retry is receipted, applies once, and broadcasts once', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const changeSet: ChangeSet = {
    id: 'legacy-comment', author: 'claude',
    ops: [{ kind: 'add_comment', cardId: 'shape:a', comment: { type: null, text: 'Once' } }],
  }
  expect((await request(app).post('/projects/essay/changeset').send(changeSet)).status).toBe(200)
  const retry = await request(app).post('/projects/essay/changeset').send(changeSet)
  expect(retry.status).toBe(200)
  expect(retry.body).toEqual({ ok: true, duplicate: true })
  expect(broadcast).toHaveBeenCalledTimes(1)
  expect((await readCanvas(path) as any).document.store['shape:a'].props.comments).toHaveLength(1)
})

test('legacy no-document request keeps 409 broadcast behavior and records no receipt', async () => {
  const { root } = await setup()
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const changeSet = create('legacy-no-document')
  const response = await request(app).post('/projects/essay/changeset').send(changeSet)
  expect(response.status).toBe(409)
  expect(response.body).toMatchObject({ applied: false })
  expect(broadcast).toHaveBeenCalledWith('essay', changeSet)
  const stored = await readCanvas(canvasPathFor(root, 'essay')!)
  expect(legacyChangeSetReceipt(stored, changeSet.id)).toBeUndefined()
  expect(pendingChangeSetsForClient(stored)).toEqual([])
})

test('legacy Task 1 bound rejection is side-effect-free and does not broadcast', async () => {
  const { root } = await setup()
  const path = await seed(root)
  const before = await bytes(path)
  const broadcast = vi.fn()
  const app = createServer(root, broadcast)
  const tooMany: ChangeSet = {
    id: 'legacy-too-many', author: 'claude',
    ops: Array.from({ length: 513 }, () => ({ kind: 'delete_card' as const, cardId: 'shape:a' })),
  }
  const response = await request(app).post('/projects/essay/changeset').send(tooMany)
  expect(response.status).toBe(413)
  expect(response.body).toMatchObject({ code: 'too-many-ops' })
  expect(await bytes(path)).toEqual(before)
  expect(broadcast).not.toHaveBeenCalled()
})
