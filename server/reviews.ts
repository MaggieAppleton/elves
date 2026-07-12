import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  Review, ReviewStatus, PersonalityId, isReview, makeReview, canTransition,
} from '../src/model/reviews'
import { projectDir } from './projects'
import type { CanvasSnapshot } from './store'

/**
 * Review passes on disk — data/projects/<id>/reviews.json, beside project.json.
 *
 * Reviews are PROJECT METADATA, not canvas content: summoning a reviewer isn't a
 * tldraw undo step, and the record must exist before an agent has touched the
 * canvas. So they get their own small file, read/written through the same
 * serialize-per-path discipline as canvas.json (see store.ts) so a UI summon and
 * an MCP claim can never lose each other's update.
 */

export class ReviewError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export function reviewsPathFor(dataRoot: string, id: string): string | null {
  const dir = projectDir(dataRoot, id)
  return dir && join(dir, 'reviews.json')
}

// Same per-path promise-chain serialization as store.ts, scoped to reviews.json.
// (store.ts's chain is deliberately private to canvas paths; reviews are a
// different file with a much simpler read-modify-write, so a local chain keeps
// the two stores independent.)
const chains = new Map<string, Promise<unknown>>()
let tmpSeq = 0

function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const tail = chains.get(path) ?? Promise.resolve()
  const run = tail.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(path, settled)
  void settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path)
  })
  return run
}

async function readFileReviews(path: string): Promise<Review[]> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  if (raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // torn write or hand-edit gone wrong: treat as empty, never crash
  }
  const list = (parsed as { reviews?: unknown })?.reviews
  if (!Array.isArray(list)) return []
  // Drop anything malformed rather than surfacing it downstream.
  return list.filter(isReview)
}

async function writeFileReviews(path: string, reviews: Review[]): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ reviews }, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

/** Read a project's reviews, newest-first. Missing/empty file = no reviews. */
export function readReviews(path: string): Promise<Review[]> {
  return enqueue(path, async () => sortNewestFirst(await readFileReviews(path)))
}

function sortNewestFirst(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
}

/**
 * Create a review. Without `agent` it is born `pending` — the UI summon, waiting
 * for an agent to claim it. With `agent` it is born `in-progress` — the
 * chat-initiated path, where the agent opening the pass IS the claim.
 */
export function createReview(
  path: string,
  args: { personality: PersonalityId; focus?: string | null; agent?: string | null },
  now: string,
): Promise<Review> {
  return enqueue(path, async () => {
    const reviews = await readFileReviews(path)
    const review = makeReview(`rev-${crypto.randomUUID()}`, args.personality, now, args.focus ?? null)
    if (args.agent) {
      review.status = 'in-progress'
      review.agent = args.agent
      review.startedAt = now
    }
    await writeFileReviews(path, [...reviews, review])
    return review
  })
}

/**
 * Transition a review through its lifecycle (see canTransition). The claim
 * (`in-progress`) requires an agent id; completion requires a verdict and stamps
 * `commentCount` from the canvas snapshot the caller passes (comments tagged
 * with this review's id). `failed` carries an optional `error` message (the
 * reason the in-app run died); any transition AWAY from `failed` — a retry's
 * `in-progress` claim, or a dismiss — clears it, since the record no longer
 * represents that failure. Illegal transitions and unknown ids throw
 * ReviewError with an HTTP-ready status.
 */
export function transitionReview(
  path: string,
  reviewId: string,
  args: { status: ReviewStatus; agent?: string | null; verdict?: string | null; error?: string | null },
  now: string,
  canvasForCounts?: CanvasSnapshot | null,
): Promise<Review> {
  return enqueue(path, async () => {
    const reviews = await readFileReviews(path)
    const idx = reviews.findIndex((r) => r.id === reviewId)
    if (idx === -1) throw new ReviewError('unknown review', 404)
    const cur = reviews[idx]
    if (!canTransition(cur.status, args.status)) {
      throw new ReviewError(`cannot move a ${cur.status} review to ${args.status}`, 409)
    }
    const next: Review = { ...cur, status: args.status }
    if (cur.status === 'failed') next.error = null // retry/dismiss leaves the old failure behind
    if (args.status === 'in-progress') {
      if (!args.agent) throw new ReviewError('claiming a review requires an agent id', 400)
      next.agent = args.agent
      next.startedAt = now
    }
    if (args.status === 'done') {
      const verdict = args.verdict?.trim()
      if (!verdict) throw new ReviewError('completing a review requires a verdict', 400)
      next.verdict = verdict
      next.completedAt = now
      next.commentCount = countReviewComments(canvasForCounts ?? null, reviewId)
    }
    if (args.status === 'failed') {
      next.error = args.error?.trim() || 'the review agent stopped before finishing'
    }
    const updated = [...reviews]
    updated[idx] = next
    await writeFileReviews(path, updated)
    return next
  })
}

/**
 * How many comments on the canvas are tagged with this review's id — the pass's
 * footprint, stamped onto the record at completion so the report survives even
 * if cards are later deleted. Counts resolved and unresolved alike (the panel
 * computes the live open/total split from the document itself).
 */
export function countReviewComments(snapshot: CanvasSnapshot | null, reviewId: string): number {
  const store = (snapshot as { document?: { store?: Record<string, unknown> } } | null)
    ?.document?.store
  if (!store) return 0
  let count = 0
  for (const record of Object.values(store)) {
    const r = record as { typeName?: string; type?: string; props?: { comments?: unknown } }
    if (r.typeName !== 'shape' || r.type !== 'card') continue
    const comments = r.props?.comments
    if (!Array.isArray(comments)) continue
    for (const c of comments) {
      if ((c as { reviewId?: unknown }).reviewId === reviewId) count++
    }
  }
  return count
}
