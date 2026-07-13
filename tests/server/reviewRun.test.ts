import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import type { AgentRunner, AgentEvent, AgentRunInput } from '../../server/agentRun'

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
function makeFakeRunner() {
  const active = new Set<string>()
  const controls = new Map<string, { onEvent: (e: AgentEvent) => void; resolve: () => void }>()
  const calls: { key: string; input: AgentRunInput }[] = []
  const cancelled: string[] = []
  const runner: AgentRunner = {
    isRunning: (key) => active.has(key),
    cancel(key, runId) {
      cancelled.push(key)
      const c = controls.get(key)
      if (!c) return { status: 'not-running' }
      if (runId !== key.slice('review:'.length)) return { status: 'run-mismatch' }
      controls.delete(key)
      active.delete(key)
      c.resolve()
      return { status: 'accepted' }
    },
    run(key, input, onEvent) {
      calls.push({ key, input })
      active.add(key)
      return new Promise<void>((resolve) => {
        controls.set(key, {
          onEvent,
          resolve: () => {
            active.delete(key)
            controls.delete(key)
            resolve()
          },
        })
      })
    },
  }
  return {
    runner,
    calls,
    cancelled,
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

async function appWithRunner(agent?: AgentRunner) {
  const d = await tmpRoot()
  const app = createServer(d, undefined, undefined, undefined, undefined, agent)
  await request(app).post('/projects').send({ name: 'Essay' }) // id: essay
  return app
}

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
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`
  expect(fake.calls).toHaveLength(1) // the summon already launched a run

  const dismissed = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'dismissed' })
  expect(dismissed.status).toBe(200)
  expect(dismissed.body.review.status).toBe('dismissed')
  expect(fake.cancelled).toEqual([key])

  // Give launchReviewRun's completion handler a moment to see the (now
  // resolved, via cancel) run and confirm it did NOT clobber dismissed → failed.
  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0].status).toBe('dismissed')
})

test('POST /reviews/:id/run retries a failed review', async () => {
  const fake = makeFakeRunner()
  const app = await appWithRunner(fake.runner)
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id
  const key = `review:${reviewId}`

  fake.emit(key, { type: 'error', message: 'boom' })
  fake.finish(key)
  await waitForReview(app, (r) => r.status === 'failed')
  expect(fake.calls).toHaveLength(1)

  const retry = await request(app).post(`/projects/essay/reviews/${reviewId}/run`)
  expect(retry.status).toBe(202)
  expect(fake.calls).toHaveLength(2) // a fresh run was launched under the SAME key
  expect(fake.calls[1].key).toBe(key)

  // Let the retry's spawned agent succeed this time.
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'in-progress', agent: 'claude' })
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'fine on retry' })
  fake.finish(key)

  await new Promise((r) => setTimeout(r, 50))
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.body.reviews[0]).toMatchObject({ status: 'done', error: null })
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
