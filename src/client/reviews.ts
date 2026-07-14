import { isReview, type Review, type PersonalityId, type ReviewStatus } from '../model/reviews'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export async function fetchReviews(projectId: string): Promise<Review[]> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/reviews`)
  if (!res.ok) throw new Error(`failed to load reviews: ${res.status}`)
  const { reviews } = (await res.json()) as { reviews: Review[] }
  return reviews
}

/**
 * Summon a reviewer from the panel: creates a PENDING review the next agent
 * working this canvas discovers (list_reviews) and claims. The app never runs
 * the review itself — the intelligence is whatever agent is connected over MCP.
 */
export async function summonReview(
  projectId: string,
  personality: PersonalityId,
  focus: string | null,
  signal?: AbortSignal,
): Promise<Review> {
  const reviewId = `rev-${crypto.randomUUID()}`
  return postReview(`${BASE}/projects/${encodeURIComponent(projectId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewId, personality, focus }),
  }, (review) => review.id === reviewId, signal)
}

/** Retry a `failed` pass (or re-summon a `pending` one that never got picked
 * up): fires the server's in-app runner again, keyed the same way the original
 * summon was. The accepted response reserves the pass as pending immediately;
 * later progress still arrives over the reviews WS broadcast. */
export async function retryReview(projectId: string, reviewId: string, signal?: AbortSignal): Promise<Review> {
  const attemptId = `attempt-${crypto.randomUUID()}`
  return postReview(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/run`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    },
    (review) => review.id === reviewId && review.attemptId === attemptId,
    signal,
  )
}

/** The user-only transition: cancel a pending summon or clear a pass from the panel. */
export async function dismissReview(projectId: string, reviewId: string, signal?: AbortSignal): Promise<Review> {
  const mutationId = `dismiss-${crypto.randomUUID()}`
  return postReview(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' satisfies ReviewStatus, mutationId }),
    },
    (review) => review.id === reviewId && review.status === 'dismissed',
    signal,
  )
}

async function postReview(
  url: string,
  init: RequestInit,
  accepts: (review: Review) => boolean,
  signal?: AbortSignal,
): Promise<Review> {
  let delayMs = 250
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal })
    } catch {
      if (signal?.aborted) throw abortReason(signal)
      await retryDelay(delayMs, signal)
      delayMs = Math.min(delayMs * 2, 5_000)
      continue
    }
    if (response.ok) {
      try {
        const { review } = (await response.json()) as { review?: unknown }
        if (isReview(review) && accepts(review)) return review
      } catch {
        // A success whose body was lost is still ambiguous; replay the same id.
      }
      await retryDelay(delayMs, signal)
      delayMs = Math.min(delayMs * 2, 5_000)
      continue
    }
    if (response.status < 500) throw new Error(`review mutation failed: ${response.status}`)
    await retryDelay(delayMs, signal)
    delayMs = Math.min(delayMs * 2, 5_000)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
