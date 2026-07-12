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
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personality, focus }),
  })
  if (!res.ok) throw new Error(`failed to summon review: ${res.status}`)
  const { review } = (await res.json()) as { review: Review }
  return review
}

/** Retry a `failed` pass (or re-summon a `pending` one that never got picked
 * up): fires the server's in-app runner again, keyed the same way the original
 * summon was. Fire-and-forget from the client's perspective — progress shows
 * up over the reviews WS broadcast like any other transition. */
export async function retryReview(projectId: string, reviewId: string): Promise<void> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/run`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error(`failed to retry review: ${res.status}`)
}

/** The user-only transition: cancel a pending summon or clear a pass from the panel. */
export async function dismissReview(projectId: string, reviewId: string): Promise<Review> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' satisfies ReviewStatus }),
    },
  )
  if (!res.ok) throw new Error(`failed to dismiss review: ${res.status}`)
  const { review } = (await res.json()) as { review: Review }
  return review
}
