import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { reviewsPathFor, readReviews, createReview, transitionReview, countReviewComments, ReviewError } from '../../server/reviews'
import type { CanvasSnapshot } from '../../server/store'

let dirs: string[] = []
async function tmpRoot() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-reviews-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

// A minimal card shape record for canvas fixtures, mirroring tests/server/api.test.ts's `mk`.
function mk(id: string, text: string, comments: Record<string, unknown>[] = []) {
  return {
    id, typeName: 'shape', type: 'card', x: 0, y: 0,
    props: {
      w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text,
      comments, mergedInto: null, draftExcluded: false, assetId: null, reference: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    },
  }
}

// ---------------------------------------------------------------------------
// Unit level: createReview / transitionReview / readReviews against a bare
// reviews.json path — no HTTP, no project.json required (writeFileReviews
// mkdir -p's the parent directory itself).
// ---------------------------------------------------------------------------

test('createReview is born pending without an agent', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'trimmer' }, '2026-07-08T10:00:00.000Z')
  expect(review).toMatchObject({
    personality: 'trimmer', status: 'pending', focus: null, agent: null, startedAt: null,
    requestedAt: '2026-07-08T10:00:00.000Z', commentCount: 0, verdict: null, completedAt: null,
  })
  expect(review.id).toMatch(/^rev-/)
})

test('createReview is born in-progress when an agent is given, and carries a focus note', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(
    path, { personality: 'architect', focus: 'the ending', agent: 'claude' }, '2026-07-08T10:00:00.000Z',
  )
  expect(review.status).toBe('in-progress')
  expect(review.agent).toBe('claude')
  expect(review.startedAt).toBe('2026-07-08T10:00:00.000Z')
  expect(review.focus).toBe('the ending')
})

test('readReviews returns [] for a project with no reviews.json yet', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  expect(await readReviews(path)).toEqual([])
})

test('readReviews sorts newest-first by requestedAt', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const older = await createReview(path, { personality: 'trimmer' }, '2026-07-01T00:00:00.000Z')
  const newest = await createReview(path, { personality: 'architect' }, '2026-07-08T00:00:00.000Z')
  const middle = await createReview(path, { personality: 'fact-checker' }, '2026-07-05T00:00:00.000Z')
  const reviews = await readReviews(path)
  expect(reviews.map((r) => r.id)).toEqual([newest.id, middle.id, older.id])
})

test('readReviews tolerates a malformed reviews.json (torn write / hand-edit) as empty', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  await fs.mkdir(join(d, 'projects', 'essay'), { recursive: true })
  await fs.writeFile(path, 'not json at all {{{', 'utf8')
  expect(await readReviews(path)).toEqual([])
})

test('readReviews drops malformed entries but keeps well-formed ones in the same file', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  await fs.mkdir(join(d, 'projects', 'essay'), { recursive: true })
  const good = await createReview(path, { personality: 'trimmer' }, '2026-07-08T00:00:00.000Z')
  const raw = JSON.parse(await fs.readFile(path, 'utf8')) as { reviews: unknown[] }
  raw.reviews.push({ id: 'rev-junk', personality: 'not-a-real-one' })
  await fs.writeFile(path, JSON.stringify(raw), 'utf8')
  const reviews = await readReviews(path)
  expect(reviews).toEqual([good])
})

test('transitionReview on an unknown review id → ReviewError 404', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  await expect(
    transitionReview(path, 'rev-ghost', { status: 'in-progress', agent: 'claude' }, '2026-07-08T00:00:00.000Z'),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    transitionReview(path, 'rev-ghost', { status: 'in-progress', agent: 'claude' }, '2026-07-08T00:00:00.000Z'),
  ).rejects.toBeInstanceOf(ReviewError)
})

test('transitionReview refuses an illegal transition → ReviewError 409', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'trimmer' }, '2026-07-08T00:00:00.000Z') // pending
  await expect(
    transitionReview(path, review.id, { status: 'done', verdict: 'x' }, '2026-07-08T00:01:00.000Z'),
  ).rejects.toMatchObject({ status: 409 })
})

test('transitionReview claiming (in-progress) without an agent → ReviewError 400', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'trimmer' }, '2026-07-08T00:00:00.000Z')
  await expect(
    transitionReview(path, review.id, { status: 'in-progress' }, '2026-07-08T00:01:00.000Z'),
  ).rejects.toMatchObject({ status: 400 })
})

test('transitionReview completing (done) without a verdict → ReviewError 400', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'trimmer', agent: 'claude' }, '2026-07-08T00:00:00.000Z')
  await expect(
    transitionReview(path, review.id, { status: 'done' }, '2026-07-08T00:01:00.000Z'),
  ).rejects.toMatchObject({ status: 400 })
  // A whitespace-only verdict is treated the same as missing.
  await expect(
    transitionReview(path, review.id, { status: 'done', verdict: '   ' }, '2026-07-08T00:01:00.000Z'),
  ).rejects.toMatchObject({ status: 400 })
})

test('transitionReview allows done → dismissed', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'trimmer', agent: 'claude' }, '2026-07-08T00:00:00.000Z')
  const done = await transitionReview(path, review.id, { status: 'done', verdict: 'tightened nicely' }, '2026-07-08T00:01:00.000Z')
  expect(done.status).toBe('done')
  const dismissed = await transitionReview(path, review.id, { status: 'dismissed' }, '2026-07-08T00:02:00.000Z')
  expect(dismissed.status).toBe('dismissed')
  expect(dismissed.verdict).toBe('tightened nicely') // completion fields survive the dismiss
})

test('transitionReview to done stamps commentCount from the canvas snapshot passed in', async () => {
  const d = await tmpRoot()
  const path = reviewsPathFor(d, 'essay')!
  const review = await createReview(path, { personality: 'devils-advocate', agent: 'claude' }, '2026-07-08T00:00:00.000Z')
  const snapshot: CanvasSnapshot = {
    document: {
      store: {
        'shape:a': mk('shape:a', 'x', [
          { id: 'c1', type: 'counterpoint', text: 'note 1', resolved: false, author: 'claude', reviewId: review.id },
          { id: 'c2', type: 'weak-argument', text: 'note 2', resolved: true, author: 'claude', reviewId: review.id },
          { id: 'c3', type: null, text: 'unrelated', resolved: false, author: 'claude', reviewId: null },
        ]),
      },
    },
    session: null,
  }
  const done = await transitionReview(path, review.id, { status: 'done', verdict: 'holds up' }, '2026-07-08T00:01:00.000Z', snapshot)
  expect(done.commentCount).toBe(2)
})

// ---------------------------------------------------------------------------
// countReviewComments — a hand-built snapshot, no server involved.
// ---------------------------------------------------------------------------

test('countReviewComments counts comments across cards tagged with the review id, resolved and unresolved alike', () => {
  const snapshot: CanvasSnapshot = {
    document: {
      store: {
        'shape:a': mk('shape:a', 'a', [
          { id: 'c1', type: null, text: 't1', resolved: false, author: 'claude', reviewId: 'rev-1' },
          { id: 'c2', type: null, text: 't2', resolved: true, author: 'claude', reviewId: 'rev-1' },
        ]),
        'shape:b': mk('shape:b', 'b', [
          { id: 'c3', type: null, text: 't3', resolved: false, author: 'claude', reviewId: 'rev-2' },
        ]),
        'page:page': { id: 'page:page', typeName: 'page' },
      },
    },
    session: null,
  }
  expect(countReviewComments(snapshot, 'rev-1')).toBe(2)
  expect(countReviewComments(snapshot, 'rev-2')).toBe(1)
  expect(countReviewComments(snapshot, 'rev-ghost')).toBe(0)
})

test('countReviewComments returns 0 for a null/empty snapshot', () => {
  expect(countReviewComments(null, 'rev-1')).toBe(0)
  expect(countReviewComments({ document: null, session: null }, 'rev-1')).toBe(0)
})

// ---------------------------------------------------------------------------
// HTTP level: the three /reviews endpoints via createServer + supertest,
// mirroring tests/server/api.test.ts's appWithTmp pattern.
// ---------------------------------------------------------------------------

async function appWithTmp(onReviews?: (projectId: string, reviews: unknown[]) => void) {
  const d = await tmpRoot()
  const app = createServer(d, undefined, undefined, undefined, undefined, undefined, onReviews as any)
  await request(app).post('/projects').send({ name: 'Essay' }) // id: essay
  return { app, dataRoot: d }
}

test('GET /reviews on a fresh project is empty', async () => {
  const { app } = await appWithTmp()
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ reviews: [] })
})

test('POST /reviews without an agent is born pending; with an agent is born in-progress', async () => {
  const { app } = await appWithTmp()
  const pending = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  expect(pending.status).toBe(200)
  expect(pending.body.review).toMatchObject({ personality: 'trimmer', status: 'pending', agent: null })

  const inProgress = await request(app).post('/projects/essay/reviews').send({ personality: 'architect', agent: 'claude' })
  expect(inProgress.status).toBe(200)
  expect(inProgress.body.review).toMatchObject({ personality: 'architect', status: 'in-progress', agent: 'claude' })
  expect(typeof inProgress.body.review.startedAt).toBe('string')
})

test('POST /reviews rejects an unknown personality', async () => {
  const { app } = await appWithTmp()
  const res = await request(app).post('/projects/essay/reviews').send({ personality: 'editor' })
  expect(res.status).toBe(400)
})

test('POST /reviews on an unknown project → 404', async () => {
  const { app } = await appWithTmp()
  const res = await request(app).post('/projects/ghost/reviews').send({ personality: 'trimmer' })
  expect(res.status).toBe(404)
})

test('GET /reviews returns newest-first', async () => {
  const { app } = await appWithTmp()
  const first = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const second = await request(app).post('/projects/essay/reviews').send({ personality: 'architect' })
  const list = await request(app).get('/projects/essay/reviews')
  expect(list.body.reviews.map((r: any) => r.id)).toEqual([second.body.review.id, first.body.review.id])
})

test('POST /reviews/:id/status claim requires an agent → 400; unknown status → 400; unknown review → 404', async () => {
  const { app } = await appWithTmp()
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  const reviewId = created.body.review.id

  const noAgent = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'in-progress' })
  expect(noAgent.status).toBe(400)

  const badStatus = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'claimed' })
  expect(badStatus.status).toBe(400)

  const unknownReview = await request(app).post('/projects/essay/reviews/rev-ghost/status').send({ status: 'dismissed' })
  expect(unknownReview.status).toBe(404)
})

test('POST /reviews/:id/status illegal transition → 409', async () => {
  const { app } = await appWithTmp()
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' }) // pending
  const reviewId = created.body.review.id
  // pending → done is illegal (must claim first)
  const res = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'x' })
  expect(res.status).toBe(409)
})

test('POST /reviews/:id/status done → dismissed is allowed', async () => {
  const { app } = await appWithTmp()
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer', agent: 'claude' })
  const reviewId = created.body.review.id
  const done = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'tightened well' })
  expect(done.status).toBe(200)
  expect(done.body.review.status).toBe('done')
  const dismissed = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'dismissed' })
  expect(dismissed.status).toBe(200)
  expect(dismissed.body.review.status).toBe('dismissed')
})

test('completing a review stamps commentCount by scanning the canvas for comments tagged with its id', async () => {
  const { app } = await appWithTmp()
  // Seed a canvas holding one card, mirroring api.test.ts's approach.
  const snap = {
    document: { store: { 'shape:a': mk('shape:a', 'the piece under review') } },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)

  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'devils-advocate', agent: 'claude' })
  const reviewId = created.body.review.id

  // Post an add_comment change-set tagged with this review's id onto the card.
  const cs = {
    id: 'cs-1', author: 'claude',
    ops: [{ kind: 'add_comment', cardId: 'shape:a', comment: { type: 'counterpoint', text: 'the unanswered objection', reviewId } }],
  }
  const csRes = await request(app).post('/projects/essay/changeset').send(cs)
  expect(csRes.status).toBe(200)

  const doneRes = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done', verdict: 'a real gap in the argument' })
  expect(doneRes.status).toBe(200)
  expect(doneRes.body.review.commentCount).toBe(1)
})

test('completing a review without a verdict → 400', async () => {
  const { app } = await appWithTmp()
  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer', agent: 'claude' })
  const reviewId = created.body.review.id
  const res = await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'done' })
  expect(res.status).toBe(400)
})

test('every review mutation invokes onReviews with the fresh, newest-first list', async () => {
  const onReviews = vi.fn()
  const { app } = await appWithTmp(onReviews)

  const created = await request(app).post('/projects/essay/reviews').send({ personality: 'trimmer' })
  expect(onReviews).toHaveBeenCalledTimes(1)
  expect(onReviews.mock.calls[0][0]).toBe('essay')
  expect(onReviews.mock.calls[0][1]).toHaveLength(1)

  const reviewId = created.body.review.id
  await request(app).post(`/projects/essay/reviews/${reviewId}/status`).send({ status: 'in-progress', agent: 'claude' })
  expect(onReviews).toHaveBeenCalledTimes(2)
  expect(onReviews.mock.calls[1][1][0]).toMatchObject({ id: reviewId, status: 'in-progress' })
})

test('GET /reviews tolerates a hand-corrupted reviews.json on disk, returning []', async () => {
  const { app, dataRoot } = await appWithTmp()
  const path = reviewsPathFor(dataRoot, 'essay')!
  await fs.writeFile(path, '{ this is not valid json', 'utf8')
  const res = await request(app).get('/projects/essay/reviews')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ reviews: [] })
})
