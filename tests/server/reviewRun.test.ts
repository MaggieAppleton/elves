import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import type {
  AgentRunner, AgentCancelResult, AgentEvent, AgentRunInput, AgentRunReservation,
} from '../../server/agentRun'

/**
 * These tests exercise `launchReviewRun` (server/app.ts) — the fire-and-forget
 * bridge from a UI summon/retry to the SAME headless runner the chat box
 * drives. We never spawn a real CLI here: a fake AgentRunner stands in, and the
 * tests play the role of "the spawned agent" by driving the run's lifecycle
 * (emit events, finish, or hit the review status route directly the way a real
 * claimed pass would via start_review/complete_review).
 */

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

// A controllable fake runner: `run` never resolves on its own — the test
// drives it via `emit` (mid-run events, e.g. a captured error) and `finish`
// (the child "exits", resolving the run's promise). `cancel` resolves the run
// immediately, mirroring a killed child's eventual 'close'.
function makeFakeRunner(
  cancelResult: AgentCancelResult = { status: 'accepted' },
  onRun: () => void = () => {},
  options: { runGate?: Promise<void>; cancelReturnGate?: Promise<void>; onReserve?: () => void } = {},
) {
  const active = new Set<string>()
  const controls = new Map<string, {
    onEvent: (e: AgentEvent) => void
    resolve: () => void
    stopped: Promise<void>
  }>()
  const reservations = new Set<AgentRunReservation>()
  const tombstones = new Set<string>()
  const calls: { key: string; input: AgentRunInput }[] = []
  const lastCall = (key: string) => [...calls].reverse().find((call) => call.key === key)
  const cancelled: string[] = []
  const runner: AgentRunner = {
    isRunning: (key) => active.has(key),
    isProjectRunning: (projectId) =>
      calls.some((call) => active.has(call.key) && call.input.projectId === projectId),
    tryLockProject: (projectId) =>
      calls.some((call) => active.has(call.key) && call.input.projectId === projectId) ||
        [...reservations].some((reservation) => reservation.projectId === projectId)
        ? null
        : () => {},
    reserveProjectRun(projectId, key, runId) {
      if (key && (active.has(key) || [...reservations].some((entry) => (entry as any).key === key))) return null
      const reservation = { projectId, key, runId }
      reservations.add(reservation)
      options.onReserve?.()
      return reservation
    },
    isRunAdmitted(key, runId) {
      if (active.has(key) && lastCall(key)?.input.runId === runId) return true
      return [...reservations].some((entry) =>
        (entry as any).key === key && (entry as any).runId === runId)
    },
    releaseProjectRun(reservation) {
      reservations.delete(reservation)
    },
    async runReserved(_reservation, key, input, onEvent) {
      if (options.runGate) await options.runGate
      if (tombstones.has(`${key}\0${input.runId}`)) return
      return start(key, input, onEvent)
    },
    abandon: () => ({ status: 'prevented' }),
    async cancelAndWait(key, runId) {
      tombstones.add(`${key}\0${runId}`)
      const control = controls.get(key)
      const result = runner.cancel(key, runId)
      if (result.status === 'accepted' && control) await control.stopped
      if (options.cancelReturnGate) await options.cancelReturnGate
      return result
    },
    cancel(key, runId) {
      cancelled.push(key)
      const c = controls.get(key)
      if (!c) return { status: 'not-running' }
      const call = lastCall(key)
      if (runId !== call?.input.runId) return { status: 'run-mismatch' }
      if (cancelResult.status !== 'accepted') return cancelResult
      return { status: 'accepted' }
    },
    run(key, input, onEvent) {
      return start(key, input, onEvent)
    },
  }
  function start(key: string, input: AgentRunInput, onEvent: (e: AgentEvent) => void) {
      onRun()
      calls.push({ key, input })
      active.add(key)
      let stop!: () => void
      const stopped = new Promise<void>((resolve) => { stop = resolve })
      return new Promise<void>((resolve) => {
        controls.set(key, {
          onEvent,
          stopped,
          resolve: () => {
            active.delete(key)
            controls.delete(key)
            stop()
            resolve()
          },
        })
      })
  }
  return {
    runner,
    calls,
    cancelled,
    reservations,
    emit(key: string, e: AgentEvent) {
      controls.get(key)?.onEvent(e)
    },
    finish(key: string) {
      controls.get(key)?.resolve()
    },
  }
}

async function tmpRoot() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-reviewrun-'))
  dirs.push(d)
  return d
}

async function appWithRunner(agent?: AgentRunner, onReviews?: () => void) {
  const d = await tmpRoot()
  const app = createServer(d, undefined, undefined, undefined, undefined, agent, onReviews)
  await request(app).post('/projects').send({ name: 'Essay' }) // id: essay
  return app
}

test('summon records the active run before awaiting its review broadcast', async () => {
  const order: string[] = []
  const fake = makeFakeRunner({ status: 'accepted' }, () => order.push('run'))
  const app = await appWithRunner(fake.runner, () => order.push('broadcast'))

  await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })

  expect(order.slice(0, 2)).toEqual(['run', 'broadcast'])
})

// Poll GET /reviews until `predicate` matches the single review, or time out —
// launchReviewRun's completion handler runs a couple of ticks (and real fs
// I/O through reviews.ts's serialized queue) after a run's promise settles.
async function waitForReview(
  app: import('express').Express,
  predicate: (r: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  const start = Date.now()
  for (;;) {
    const res = await request(app).get('/projects/essay/reviews')
    const review = res.body.reviews[0]
    if (review && predicate(review)) return review
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForReview timed out; last seen: ${JSON.stringify(review)}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('summoning fires a run keyed review:<id> with the review prompt', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id

  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0].key).toBe(`review:${reviewId}`)
  expect(fake.calls[0].input.projectId).toBe('essay')
  expect(fake.calls[0].input.hasSelection).toBe(false)
  expect(fake.calls[0].input.prompt).toContain(reviewId)
  expect(fake.calls[0].input.prompt).toContain('start_review')
  expect(fake.calls[0].input.prompt).toContain('complete_review')
})

test('summon is idempotent for a stable client review id', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const body = { reviewId: 'rev-client-a', personality: 'trimmer' }

  const first = await request(app).post('/projects/essay/reviews').send(body)
  const duplicate = await request(app).post('/projects/essay/reviews').send(body)

  expect(first.body.review.id).toBe('rev-client-a')
  expect(duplicate.body.review).toEqual(first.body.review)
  expect(fake.calls).toHaveLength(1)
})

test('summon reserves the project before metadata work so concurrent rename is refused', async () => {
  let observeReserve!: () => void
  const reserved = new Promise<void>((resolve) => { observeReserve = resolve })
  const fake = makeFakeRunner({ status: 'accepted' }, () => {}, { onReserve: observeReserve })
  const app = await appWithRunner(fake.runner)

  const summoning = request(app).post('/projects/essay/reviews').send({
    reviewId: 'rev-client-a', personality: 'trimmer',
  })
  void summoning.then(() => {})
  await reserved
  const rename = await request(app).patch('/projects/essay').send({ name: 'Renamed' })

  expect(rename.status).toBe(409)
  expect((await summoning).status).toBe(200)
})

test('a run that errors marks the review failed with the captured message', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`

  fake.emit(key, { type: 'error', message: '`claude` is not installed' })
  fake.finish(key)

  const failed = await waitForReview(app, (r) => r.status === 'failed')
  expect(failed.id).toBe(reviewId)
  expect(failed.error).toBe('`claude` is not installed')
})

test('a run that exits with no captured error still fails the review, with a generic message', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  fake.finish(`review:${reviewId}`) // exits clean, but never claimed/completed the pass

  const failed = await waitForReview(app, (r) => r.status === 'failed')
  expect(failed.error).toBe('the review agent stopped before finishing')
})

test('a run that completes (claims + finishes via the status route) leaves the review done', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`

  // Play the spawned agent: claim (start_review) then complete_review, over
  // the same HTTP routes the MCP tools call.
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'in-progress', agent: 'claude' })
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'tightened well' })
  fake.finish(key) // the child exits 0 after complete_review returns

  // Give the completion handler a moment to run its (no-op) check, then assert
  // it never overwrote the done pass with failed.
  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0]).toMatchObject({ id: reviewId, status: 'done', verdict: 'tightened well' })
})

test('dismissing mid-run cancels the child and the review stays dismissed', async () => {
  let releaseCancellation!: () => void
  const cancelReturnGate = new Promise<void>((resolve) => { releaseCancellation = resolve })
  const fake = makeFakeRunner({ status: 'accepted' }, () => {}, { cancelReturnGate })
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`
  expect(fake.calls).toHaveLength(1) // the summon already launched a run

  let settled = false
  const dismissing = request(app)
    .post(`/projects/essay/reviews/${reviewId}/status`)
    .send({ status: 'dismissed', mutationId: 'dismiss-a' })
    .then((response) => {
      settled = true
      return response
    })
  for (let attempt = 0; attempt < 20 && fake.cancelled.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  expect(fake.cancelled).toEqual([key])
  expect(settled).toBe(false)
  fake.finish(key)
  for (let attempt = 0; attempt < 20 && fake.reservations.size > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const rename = await request(app).patch('/projects/essay').send({ name: 'Too Soon' })
  releaseCancellation()

  const dismissed = await dismissing
  expect(rename.status).toBe(409)
  expect(dismissed.status).toBe(200)
  expect(dismissed.body.review.status).toBe('dismissed')

  // Give launchReviewRun's completion handler a moment to see the (now
  // resolved, via cancel) run and confirm it did NOT clobber dismissed → failed.
  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0].status).toBe('dismissed')
})

test('dismiss is idempotent after a lost successful response', async () => {
  const app = await appWithRunner(undefined)
  const created = await request(app).post('/projects/essay/reviews').send({
    reviewId: 'rev-client-a', personality: 'trimmer',
  })
  const url = `/projects/essay/reviews/${created.body.review.id}/status`

  const first = await request(app).post(url).send({ status: 'dismissed', mutationId: 'dismiss-a' })
  const duplicate = await request(app).post(url).send({ status: 'dismissed', mutationId: 'dismiss-a' })

  expect(first.status).toBe(200)
  expect(duplicate.status).toBe(200)
  expect(duplicate.body.review).toEqual(first.body.review)
})

test('dismiss before child admission tombstones the attempt so it never starts late', async () => {
  let releaseRun!: () => void
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
  const fake = makeFakeRunner({ status: 'accepted' }, () => {}, { runGate })
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({
    reviewId: 'rev-client-a', personality: 'trimmer',
  })

  const dismissed = await request(app)
    .post('/projects/essay/reviews/rev-client-a/status')
    .send({ status: 'dismissed', mutationId: 'dismiss-a' })
  releaseRun()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(dismissed.status).toBe(200)
  expect(created.body.review.attemptId).toBe('rev-client-a')
  expect(fake.calls).toHaveLength(0)
  expect((await request(app).get('/projects/essay/reviews')).body.reviews[0].status).toBe('dismissed')
})

test('a failed cancel leaves the live review visible and reports the failure', async () => {
  const fake = makeFakeRunner({ status: 'signal-failed' })
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`

  const dismissed = await request(app)
    .post(`/projects/essay/reviews/${reviewId}/status`)
    .send({ status: 'dismissed' })

  expect(dismissed.status).toBe(503)
  expect(dismissed.body).toMatchObject({ code: 'signal-failed' })
  const current = await request(app).get('/projects/essay/reviews')
  expect(current.body.reviews[0].status).toBe('pending')

  fake.finish(key)
  await waitForReview(app, (r) => r.status === 'failed')
})

test('POST /reviews/:id/run retries a failed review', async () => {
  const order: string[] = []
  const fake = makeFakeRunner({ status: 'accepted' }, () => order.push('run'))
  const app = await appWithRunner(fake.runner, () => order.push('broadcast'))
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`

  fake.emit(key, { type: 'error', message: 'boom' })
  fake.finish(key)
  await waitForReview(app, (r) => r.status === 'failed')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fake.calls).toHaveLength(1)
  order.length = 0

  const retry = await request(app).post(`/projects/essay/reviews/${reviewId}/run`).send({ attemptId: 'attempt-a' })
  expect(retry.status).toBe(202)
  expect(retry.body.review).toMatchObject({ id: reviewId, status: 'pending', error: null, attemptId: 'attempt-a' })
  expect(fake.calls).toHaveLength(2) // a fresh run was launched under the SAME key
  expect(fake.calls[1].key).toBe(key)
  expect(order.slice(0, 2)).toEqual(['run', 'broadcast'])

  const duplicate = await request(app)
    .post(`/projects/essay/reviews/${reviewId}/run`)
    .send({ attemptId: 'attempt-a' })
  expect(duplicate.body.review.attemptId).toBe('attempt-a')
  expect(fake.calls).toHaveLength(2)

  // Let the retry's spawned agent succeed this time.
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'in-progress', agent: 'claude' })
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'fine on retry' })
  fake.finish(key)

  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0]).toMatchObject({ status: 'done', error: null })
})

test('concurrent distinct retry attempts admit only one child', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`
  fake.emit(key, { type: 'error', message: 'boom' })
  fake.finish(key)
  await waitForReview(app, (review) => review.status === 'failed')

  const [a, b] = await Promise.all([
    request(app).post(`/projects/essay/reviews/${reviewId}/run`).send({ attemptId: 'attempt-a' }),
    request(app).post(`/projects/essay/reviews/${reviewId}/run`).send({ attemptId: 'attempt-b' }),
  ])

  expect([a.status, b.status].sort()).toEqual([202, 409])
  expect(fake.calls).toHaveLength(2)
  const acceptedAttempt = a.status === 202 ? 'attempt-a' : 'attempt-b'
  expect(fake.calls[1].input.runId).toBe(acceptedAttempt)
})

test('POST /reviews/:id/run on an unknown review → 404', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const res = await request(app).post('/projects/essay/reviews/rev-ghost/run')
  expect(res.status).toBe(404)
})

test('retry no-ops (still 202) if the review is already running under its key', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  expect(fake.calls).toHaveLength(1) // the summon's own run is still active (never finished)

  const retry = await request(app).post(`/projects/essay/reviews/${reviewId}/run`)
  expect(retry.status).toBe(202)
  expect(fake.calls).toHaveLength(1) // launchReviewRun's isRunning(key) guard skipped a second launch
})

test('with no runner configured, a summoned review simply stays pending', async () => {
  const app = await appWithRunner(undefined)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  expect(created.body.review.status).toBe('pending')

  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0].status).toBe('pending')
})
