import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { withProjectLock } from '../../server/projectLock'

const lockProbe = vi.hoisted(() => {
  type Entry = { kind: 'project' | 'multi'; dataRoot: string; ids: string[] }
  const entries: Entry[] = []
  const waiters: Array<{
    predicate: (current: Entry[]) => boolean
    resolve: () => void
    reject: (error: Error) => void
    deadline: ReturnType<typeof setTimeout>
  }> = []
  return {
    record(entry: Entry) {
      entries.push(entry)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (!waiters[i].predicate(entries)) continue
        const waiter = waiters.splice(i, 1)[0]
        clearTimeout(waiter.deadline)
        waiter.resolve()
      }
    },
    waitFor(predicate: (current: Entry[]) => boolean, timeoutMs = 2_000): Promise<void> {
      if (predicate(entries)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          deadline: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index !== -1) waiters.splice(index, 1)
            reject(new Error(`lock probe timed out after ${timeoutMs}ms`))
          }, timeoutMs),
        }
        waiters.push(waiter)
      })
    },
    reset() {
      entries.length = 0
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.deadline)
        waiter.reject(new Error('lock probe reset'))
      }
    },
  }
})

vi.mock('../../server/projectLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/projectLock')>()
  return {
    ...actual,
    withProjectLock: <T>(dataRoot: string, id: string, task: () => Promise<T>): Promise<T> => {
      const result = actual.withProjectLock(dataRoot, id, task)
      lockProbe.record({ kind: 'project', dataRoot, ids: [id] })
      return result
    },
    withProjectLocks: <T>(dataRoot: string, ids: readonly string[], task: () => Promise<T>): Promise<T> => {
      const result = actual.withProjectLocks(dataRoot, ids, task)
      lockProbe.record({ kind: 'multi', dataRoot, ids: [...ids] })
      return result
    },
  }
})

let dirs: string[] = []
const servers: Server[] = []
async function appWithTmp() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  const server = createHttpServer(createServer(d))
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return server
}

async function holdProject(dataRoot: string, id: string): Promise<{
  release: () => void
  done: Promise<void>
}> {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const done = withProjectLock(dataRoot, id, async () => {
    entered()
    await gate
  })
  await started
  return { release, done }
}

async function waitForProjectQueue(dataRoot: string, id: string): Promise<void> {
  await lockProbe.waitFor((entries) => entries.some(
    (entry) => entry.kind === 'project' && entry.dataRoot === dataRoot && entry.ids[0] === id,
  ))
}

async function waitForRenameQueue(dataRoot: string, oldId: string, newId: string): Promise<void> {
  await lockProbe.waitFor((entries) => entries.some(
    (entry) => entry.kind === 'multi' && entry.dataRoot === dataRoot
      && entry.ids.includes(oldId) && entry.ids.includes(newId),
  ))
}

function startHandled<T>(task: () => Promise<T>): Promise<T> {
  const result = Promise.resolve().then(task)
  void result.catch(() => undefined)
  return result
}

const activeRaceHelpers = new Set<Promise<void>>()

function trackRaceHelper<T>(run: Promise<T>): Promise<T> {
  const settled = run.then(() => undefined, () => undefined)
  activeRaceHelpers.add(settled)
  void settled.then(() => { activeRaceHelpers.delete(settled) })
  return run
}

function mutationBeforeRename<T, U>(
  dataRoot: string,
  mutation: () => Promise<T>,
  rename: () => Promise<U>,
): Promise<[T, U]> {
  return trackRaceHelper((async () => {
    const hold = await holdProject(dataRoot, 'essay')
    let released = false
    let mutationResult: Promise<T> | undefined
    let renameResult: Promise<U> | undefined
    const release = () => {
      if (released) return
      released = true
      hold.release()
    }
    try {
      lockProbe.reset()
      mutationResult = startHandled(mutation)
      await waitForProjectQueue(dataRoot, 'essay')
      renameResult = startHandled(rename)
      await waitForRenameQueue(dataRoot, 'essay', 'final')
      release()
      await hold.done
      return await Promise.all([mutationResult, renameResult])
    } finally {
      release()
      await hold.done
      await Promise.allSettled([mutationResult, renameResult].filter(
        (result): result is Promise<T> | Promise<U> => result !== undefined,
      ))
    }
  })())
}

function renameBeforeMutation<T, U>(
  dataRoot: string,
  rename: () => Promise<T>,
  mutation: () => Promise<U>,
): Promise<[T, U]> {
  return trackRaceHelper((async () => {
    const hold = await holdProject(dataRoot, 'essay')
    let released = false
    let renameResult: Promise<T> | undefined
    let mutationResult: Promise<U> | undefined
    const release = () => {
      if (released) return
      released = true
      hold.release()
    }
    try {
      lockProbe.reset()
      renameResult = startHandled(rename)
      await waitForRenameQueue(dataRoot, 'essay', 'final')
      mutationResult = startHandled(mutation)
      await waitForProjectQueue(dataRoot, 'essay')
      release()
      await hold.done
      return await Promise.all([renameResult, mutationResult])
    } finally {
      release()
      await hold.done
      await Promise.allSettled([renameResult, mutationResult].filter(
        (result): result is Promise<T> | Promise<U> => result !== undefined,
      ))
    }
  })())
}
afterEach(async () => {
  lockProbe.reset()
  await Promise.allSettled([...activeRaceHelpers])
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })))
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('lock probe reset rejects a pending waiter', async () => {
  const pending = lockProbe.waitFor(() => false)
  const rejected = expect(pending).rejects.toThrow('reset')
  lockProbe.reset()
  await rejected
})

test('lock probe deadline rejects a pending waiter', async () => {
  vi.useFakeTimers()
  const pending = lockProbe.waitFor(() => false, 100)
  const rejected = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(100)
  await rejected
})

test('race helper releases its held lock and drains HTTP when queue setup fails', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const snapshot = { document: { records: [{ id: 'drained' }] }, session: null }
  let attempted!: () => void
  const renameAttempted = new Promise<void>((resolve) => { attempted = resolve })
  const raced = mutationBeforeRename(
    dataRoot,
    () => request(app).post('/projects/essay/canvas').send(snapshot).then((response) => response),
    async () => {
      attempted()
      throw new Error('rename setup failed')
    },
  )
  await renameAttempted
  lockProbe.reset()
  await expect(raced).rejects.toThrow()
  await expect(withProjectLock(dataRoot, 'essay', async () => 'released')).resolves.toBe('released')
  const canvas = await request(app).get('/projects/essay/canvas')
  expect(canvas.status).toBe(200)
  expect(canvas.body).toEqual(snapshot)
})

// A minimal card shape record for canvas fixtures; override props as needed.
function mk(
  id: string, kind: 'prose' | 'note', x: number, y: number, text: string,
  props: Record<string, unknown> = {},
) {
  return {
    id, typeName: 'shape', type: 'card', x, y,
    props: {
      w: 240, h: 120, kind, noteKind: null, origin: null, text,
      comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null, ...props,
    },
  }
}

test('projects start empty, then create + list', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects')).body).toEqual([])
  const created = await request(app).post('/projects').send({ name: 'Essay' })
  expect(created.status).toBe(200)
  expect(created.body).toMatchObject({ id: 'essay', name: 'Essay' })
  expect(typeof created.body.createdAt).toBe('string')
  const list = await request(app).get('/projects')
  expect(list.body).toHaveLength(1)
  expect(list.body[0]).toMatchObject({ id: 'essay', name: 'Essay' })
})

test('rename re-slugs the id to match the new name; the old id 404s', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Draft' })
  const r = await request(app).patch('/projects/draft').send({ name: 'Final' })
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ id: 'final', name: 'Final' })
  // The folder moved: the old id no longer resolves, the new one does.
  expect((await request(app).get('/projects/draft/canvas')).status).toBe(404)
  const list = await request(app).get('/projects')
  expect(list.body.map((p: { id: string }) => p.id)).toEqual(['final'])
})

test('rename of an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).patch('/projects/ghost').send({ name: 'X' })).status).toBe(404)
})

test('GET canvas returns empty before anything is saved', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const res = await request(app).get('/projects/essay/canvas')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ document: null, session: null })
})

test('POST then GET round-trips the snapshot within a project', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  const post = await request(app).post('/projects/essay/canvas').send(snap)
  expect(post.body).toEqual({ ok: true })
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual(snap)
})

test('two projects keep separate canvases', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'One' })
  await request(app).post('/projects').send({ name: 'Two' })
  await request(app).post('/projects/one/canvas').send({ document: { n: 1 }, session: null })
  await request(app).post('/projects/two/canvas').send({ document: { n: 2 }, session: null })
  expect((await request(app).get('/projects/one/canvas')).body.document).toEqual({ n: 1 })
  expect((await request(app).get('/projects/two/canvas')).body.document).toEqual({ n: 2 })
})

test('scoped routes on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects/ghost/canvas')).status).toBe(404)
  expect((await request(app).get('/projects/ghost/map')).status).toBe(404)
  expect((await request(app).get('/projects/ghost/draft')).status).toBe(404)
  expect((await request(app).post('/projects/ghost/cards').send({ ids: [] })).status).toBe(404)
  expect((await request(app).post('/projects/ghost/canvas').send({ document: null })).status).toBe(404)
})

test('GET /draft compiles the canvas into ordered narrative blocks', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // Two sections (Origins left, Turn right) with a card each, plus an opening
  // card left of both. Cards are placed so that reading order can only be right
  // if bands + within-band y ordering are honored (not a raw x scan).
  const snap = {
    document: {
      store: {
        'shape:intro': mk('shape:intro', 'prose', -400, 0, 'An opening thought.'),
        'shape:o1': mk('shape:o1', 'prose', 60, 300, 'Origins, lower.'),
        'shape:o2': mk('shape:o2', 'prose', 200, 0, 'Origins, upper.'),
        'shape:t1': mk('shape:t1', 'prose', 1060, 0, 'The turn.'),
        'shape:excluded': mk('shape:excluded', 'prose', 60, 600, 'left out', { draftExcluded: true }),
        'shape:sOrigins': { id: 'shape:sOrigins', typeName: 'shape', type: 'section', x: 0, y: -100, props: { w: 320, h: 72, text: 'Origins', authoredBy: 'user' } },
        'shape:sTurn': { id: 'shape:sTurn', typeName: 'shape', type: 'section', x: 1000, y: -100, props: { w: 320, h: 72, text: 'The turn', authoredBy: 'claude' } },
      },
    },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)
  const res = await request(app).get('/projects/essay/draft')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({
    blocks: [
      { section: null, cards: [{ id: 'shape:intro', text: 'An opening thought.' }] },
      { section: 'Origins', cards: [
        { id: 'shape:o2', text: 'Origins, upper.' }, // upper first, though further right
        { id: 'shape:o1', text: 'Origins, lower.' },
      ] },
      { section: 'The turn', cards: [{ id: 'shape:t1', text: 'The turn.' }] },
    ],
  })
})

test('a traversal-shaped id is rejected as unknown (404)', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects/..%2f..%2fetc/canvas')).status).toBe(404)
})

test('POST /projects rejects a blank or missing name', async () => {
  const app = await appWithTmp()
  expect((await request(app).post('/projects').send({ name: '' })).status).toBe(400)
  expect((await request(app).post('/projects').send({})).status).toBe(400)
})

test('POST canvas rejects a non-object body', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  expect((await request(app).post('/projects/essay/canvas').send([1, 2, 3])).status).toBe(400)
})

test('POST canvas refuses to blank a non-empty canvas (409), leaving it intact', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  await request(app).post('/projects/essay/canvas').send(snap)
  // An empty save over a real document is refused...
  const res = await request(app).post('/projects/essay/canvas').send({ document: null, session: null })
  expect(res.status).toBe(409)
  // ...and the real canvas is untouched.
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual(snap)
})

test('POST canvas allows an empty save when the canvas is still empty', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // Nothing saved yet → an empty snapshot is harmless and accepted.
  const res = await request(app).post('/projects/essay/canvas').send({ document: null, session: null })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
})

test('DELETE canvas clears an existing canvas back to empty', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const snap = { document: { schema: 1, records: [] }, session: null }
  await request(app).post('/projects/essay/canvas').send(snap)
  const del = await request(app).delete('/projects/essay/canvas')
  expect(del.status).toBe(200)
  expect(del.body).toEqual({ ok: true })
  // Cleared → reads back as empty; a fresh save is then accepted again.
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual({ document: null, session: null })
  expect((await request(app).post('/projects/essay/canvas').send(snap)).status).toBe(200)
})

test('DELETE canvas on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).delete('/projects/ghost/canvas')).status).toBe(404)
})

test('a canvas save queued before rename completes and moves with the project', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const snapshot = { document: { records: [{ id: 'queued-save' }] }, session: null }
  const [save, rename] = await mutationBeforeRename(
    dataRoot,
    () => request(app).post('/projects/essay/canvas').send(snapshot).then((response) => response),
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
  )
  expect(save.status).toBe(200)
  expect(rename.status).toBe(200)
  const movedCanvas = await request(app).get('/projects/final/canvas')
  expect(movedCanvas.status).toBe(200)
  expect(movedCanvas.body).toEqual(snapshot)
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('an asset upload queued before rename completes in the renamed project', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const [upload, rename] = await mutationBeforeRename(
    dataRoot,
    () => request(app).post('/projects/essay/assets')
      .set('content-type', 'image/png')
      .send(Buffer.from([1]))
      .then((response) => response),
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
  )
  expect(upload.status).toBe(200)
  expect(rename.status).toBe(200)
  expect(upload.body.assetId).toMatch(/\.png$/)
  await expect(
    fs.readFile(join(dataRoot, 'projects', 'final', 'assets', upload.body.assetId)),
  ).resolves.toEqual(Buffer.from([1]))
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a review creation queued before rename completes in the renamed project', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const [create, rename] = await mutationBeforeRename(
    dataRoot,
    () => request(app).post('/projects/essay/reviews').send({
      personality: 'trimmer',
      agent: 'reviewer',
    }).then((response) => response),
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
  )
  expect(create.status).toBe(200)
  expect(rename.status).toBe(200)
  expect(create.body.review).toMatchObject({ personality: 'trimmer', status: 'in-progress' })
  const reviews = await request(app).get('/projects/final/reviews')
  expect(reviews.status).toBe(200)
  expect(reviews.body.reviews).toContainEqual(create.body.review)
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rename queued before an HTTP canvas save makes the old-id writer 404 without an orphan', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const [renameResponse, saveResponse] = await renameBeforeMutation(
    dataRoot,
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
    () => request(app).post('/projects/essay/canvas')
      .send({ document: { schema: 1, records: [{ id: 'raced' }] }, session: null })
      .then((response) => response),
  )
  expect(renameResponse.status).toBe(200)
  expect(saveResponse.status).toBe(404)
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
  const finalCanvas = await request(app).get('/projects/final/canvas')
  expect(finalCanvas.status).toBe(200)
  expect(finalCanvas.body).toEqual({ document: null, session: null })
})

test('rename queued before an asset upload makes the old-id writer 404 without an orphan', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const [renameResponse, uploadResponse] = await renameBeforeMutation(
    dataRoot,
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
    () => request(app).post('/projects/essay/assets')
      .set('content-type', 'image/png')
      .send(Buffer.from([1]))
      .then((response) => response),
  )
  expect(renameResponse.status).toBe(200)
  expect(uploadResponse.status).toBe(404)
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rename queued before review creation makes the old-id writer 404 without an orphan', async () => {
  const app = await appWithTmp()
  const dataRoot = dirs[dirs.length - 1]
  await request(app).post('/projects').send({ name: 'Essay' })
  const [renameResponse, reviewResponse] = await renameBeforeMutation(
    dataRoot,
    () => request(app).patch('/projects/essay').send({ name: 'Final' }).then((response) => response),
    () => request(app).post('/projects/essay/reviews')
      .send({ personality: 'trimmer', agent: 'reviewer' })
      .then((response) => response),
  )
  expect(renameResponse.status).toBe(200)
  expect(reviewResponse.status).toBe(404)
  const finalReviews = await request(app).get('/projects/final/reviews')
  expect(finalReviews.status).toBe(200)
  expect(finalReviews.body).toEqual({ reviews: [] })
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('unfurl requires a valid http(s) url', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  expect((await request(app).post('/projects/essay/unfurl').send({})).status).toBe(400)
  expect((await request(app).post('/projects/essay/unfurl').send({ url: 'ftp://x' })).status).toBe(400)
})

test('unfurl on an unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).post('/projects/ghost/unfurl').send({ url: 'https://x.com' })).status).toBe(404)
})

test('unfurl degrades to a minimal reference when the page cannot be fetched', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  // A .invalid host fails DNS immediately — exercises the graceful fallback with
  // no real outbound request.
  const res = await request(app).post('/projects/essay/unfurl').send({ url: 'https://elves.invalid/paper' })
  expect(res.status).toBe(200)
  expect(res.body.reference).toMatchObject({
    url: 'https://elves.invalid/paper', fetchedBy: 'unfurl', title: null,
  })
}, 15000)

test('a write failure returns 500 instead of crashing the server', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  const app = createServer(d)
  await request(app).post('/projects').send({ name: 'Essay' })
  // Force writeCanvas to fail deterministically while the project still resolves:
  // make canvas.json a DIRECTORY, so the atomic rename onto it throws. Without an
  // error boundary the rejected promise is fatal; with one, we get a clean 500.
  await fs.mkdir(join(d, 'projects', 'essay', 'canvas.json'))
  const res = await request(app)
    .post('/projects/essay/canvas')
    .send({ document: null, session: null })
  expect(res.status).toBe(500)
}, 10000)

// --- CORS allowlist (issue #29) ---------------------------------------------
// The default allowlist includes the Vite client dev port (5173); see
// server/origins.ts. These use the request's own default port (no PORT env
// set in this test run) so they exercise the real default allowlist.

test('a disallowed cross-origin Origin does not get Access-Control-Allow-Origin', async () => {
  const app = await appWithTmp()
  const res = await request(app).get('/projects').set('Origin', 'https://evil.example')
  expect(res.status).toBe(200) // the request itself still completes...
  expect(res.headers['access-control-allow-origin']).toBeUndefined() // ...but a browser can't read it cross-origin
})

test('unfurl cancels oversized streamed HTML and degrades to a minimal reference', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const chunks = [
    '<html><head><title>Too large</title></head><body>',
    'x'.repeat(750_000),
    'x'.repeat(750_000),
    'x'.repeat(750_000),
    'x'.repeat(750_000),
    'x'.repeat(750_000),
  ].map((chunk) => new TextEncoder().encode(chunk))
  let pulls = 0
  let cancelled = false
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/html' } }))

  const res = await request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })

  expect(res.status).toBe(200)
  expect(res.body.reference.title).toBeNull()
  expect(cancelled).toBe(true)
  expect(pulls).toBeLessThan(chunks.length)
})

test.each([
  ['non-OK', 502, 'text/html'],
  ['non-HTML', 200, 'text/plain'],
])('unfurl cancels a %s final HTML response before falling back', async (_case, status, contentType) => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  let cancelled = false
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('rejected body')) },
    cancel() { cancelled = true },
  }), { status, headers: { 'content-type': contentType } }))

  const res = await request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })

  expect(res.status).toBe(200)
  expect(res.body.reference.title).toBeNull()
  expect(cancelled).toBe(true)
})

test('unfurl cancels an oversized streamed image and keeps its asset null', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const chunks = Array.from({ length: 6 }, () => new Uint8Array(1_500_000))
  let pulls = 0
  let cancelled = false
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).endsWith('/page')) {
      return new Response(
        '<html><head><title>Normal page</title><link rel="icon" href="/large.png"></head></html>',
        { headers: { 'content-type': 'text/html' } },
      )
    }
    return new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks[pulls++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'image/png' } })
  })

  const res = await request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })

  expect(res.status).toBe(200)
  expect(res.body.reference.title).toBe('Normal page')
  expect(res.body.reference.faviconAssetId).toBeNull()
  expect(cancelled).toBe(true)
  expect(pulls).toBeLessThan(chunks.length)
})

test.each([
  ['non-OK', 502, 'image/png'],
  ['non-image', 200, 'text/plain'],
])('unfurl cancels a %s final image response and keeps its asset null', async (_case, status, contentType) => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  let cancelled = false
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).endsWith('/page')) {
      return new Response(
        '<html><head><title>Normal page</title><link rel="icon" href="/rejected.png"></head></html>',
        { headers: { 'content-type': 'text/html' } },
      )
    }
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      cancel() { cancelled = true },
    }), { status, headers: { 'content-type': contentType } })
  })

  const res = await request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })

  expect(res.status).toBe(200)
  expect(res.body.reference.title).toBe('Normal page')
  expect(res.body.reference.faviconAssetId).toBeNull()
  expect(cancelled).toBe(true)
})

test('unfurl keeps its deadline active while consuming the HTML body', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  vi.useFakeTimers()
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let markFetchStarted!: () => void
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => {
    markFetchStarted()
    return new Response(new ReadableStream({
      start(controller) {
        bodyController = controller
        controller.enqueue(new TextEncoder().encode('<html><head><title>Slow page</title>'))
      },
      pull() { return new Promise(() => undefined) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/html' } })
  }))

  const pending = request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })
    .then((res) => res)
  await fetchStarted
  await vi.advanceTimersByTimeAsync(8_000)
  const cancelledAtDeadline = cancelled
  if (!cancelled) bodyController.close()
  vi.useRealTimers()
  const res = await pending

  expect(cancelledAtDeadline).toBe(true)
  expect(res.body.reference.title).toBeNull()
})

test('unfurl accepts HTML and image bodies exactly at their byte limits', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  const prefix = '<html><head><title>Exact limits</title><link rel="icon" href="/exact.png"></head><body>'
  const suffix = '</body></html>'
  const html = prefix + 'x'.repeat(2_000_000 - prefix.length - suffix.length) + suffix
  const image = new Uint8Array(5_000_000)
  vi.stubGlobal('fetch', async (url: string | URL) => String(url).endsWith('/page')
    ? new Response(html, { headers: { 'content-type': 'text/html' } })
    : new Response(image, { headers: { 'content-type': 'image/png' } }))

  const res = await request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })

  expect(res.status).toBe(200)
  expect(res.body.reference.title).toBe('Exact limits')
  expect(res.body.reference.faviconAssetId).toMatch(/\.png$/)
})

test('unfurl cancels an image body at the deadline and keeps its asset null', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  vi.useFakeTimers()
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let markImageStarted!: () => void
  const imageStarted = new Promise<void>((resolve) => { markImageStarted = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/page')) {
      return new Response(
        '<html><head><title>Normal page</title><link rel="icon" href="/slow.png"></head></html>',
        { headers: { 'content-type': 'text/html' } },
      )
    }
    markImageStarted()
    return new Response(new ReadableStream({
      start(controller) {
        bodyController = controller
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      pull() { return new Promise(() => undefined) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'image/png' } })
  }))

  const pending = request(app)
    .post('/projects/essay/unfurl')
    .send({ url: 'http://93.184.216.34/page' })
    .then((res) => res)
  await imageStarted
  await vi.advanceTimersByTimeAsync(8_000)
  const cancelledAtDeadline = cancelled
  if (!cancelled) bodyController.close()
  vi.useRealTimers()
  const res = await pending

  expect(cancelledAtDeadline).toBe(true)
  expect(res.body.reference.title).toBe('Normal page')
  expect(res.body.reference.faviconAssetId).toBeNull()
})

test('the allowed client dev origin gets Access-Control-Allow-Origin echoed back', async () => {
  const app = await appWithTmp()
  const res = await request(app).get('/projects').set('Origin', 'http://localhost:5173')
  expect(res.status).toBe(200)
  expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
})

test('a request with no Origin header (supertest default) still works', async () => {
  const app = await appWithTmp()
  const res = await request(app).get('/projects')
  expect(res.status).toBe(200)
})
