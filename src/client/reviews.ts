import type { Review, PersonalityId, ReviewStatus } from '../model/reviews'

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
): Promise<Review> {
  const reviewId = `rev-${crypto.randomUUID()}`
  return postReview(`${BASE}/projects/${encodeURIComponent(projectId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewId, personality, focus }),
  })
}

/** Retry a `failed` pass (or re-summon a `pending` one that never got picked
 * up): fires the server's in-app runner again, keyed the same way the original
 * summon was. The accepted response reserves the pass as pending immediately;
 * later progress still arrives over the reviews WS broadcast. */
export async function retryReview(projectId: string, reviewId: string): Promise<Review> {
  const attemptId = `attempt-${crypto.randomUUID()}`
  return postReview(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/run`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    },
  )
}

/** The user-only transition: cancel a pending summon or clear a pass from the panel. */
export async function dismissReview(projectId: string, reviewId: string): Promise<Review> {
  const mutationId = `dismiss-${crypto.randomUUID()}`
  return postReview(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' satisfies ReviewStatus, mutationId }),
    },
  )
}

async function postReview(url: string, init: RequestInit): Promise<Review> {
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      await retryDelay()
      continue
    }
    if (response.ok) {
      try {
        const { review } = (await response.json()) as { review?: Review }
        if (review?.id) return review
      } catch {
        // A success whose body was lost is still ambiguous; replay the same id.
      }
      await retryDelay()
      continue
    }
    if (response.status < 500) throw new Error(`review mutation failed: ${response.status}`)
    await retryDelay()
  }
}

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250))
}
