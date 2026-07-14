import type { ChangeSet } from '../src/model/changeset'
import type { CardDigest, CardMap } from '../server/digest'
import type { Project } from '../server/projects'
import type { Reference } from '../src/model/types'
import type { ReadDraftBlock } from '../src/model/draft'
import type { Review, ReviewStatus, PersonalityId } from '../src/model/reviews'
import type { SelectedShape } from '../server/selection'

export type ProjectSummary = Pick<Project, 'id' | 'name'>

/** The user's current canvas selection. `project`/`selectedAt` are absent when
 * nothing is selected yet (or the selected project is gone) — `selection` is
 * then an empty array. */
export interface SelectionResponse {
  project?: string
  selection: SelectedShape[]
  selectedAt?: string
}

export async function listProjects(baseUrl: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${baseUrl}/projects`)
  if (!res.ok) throw new Error(`list_projects failed: ${res.status}`)
  const projects = (await res.json()) as Project[]
  return projects.map((p) => ({ id: p.id, name: p.name }))
}

export async function readCardMap(baseUrl: string, projectId: string): Promise<CardMap> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/map`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_map failed: ${res.status}`)
  return res.json() as Promise<CardMap>
}

export async function readSelection(baseUrl: string): Promise<SelectionResponse> {
  const res = await fetch(`${baseUrl}/selection`)
  if (!res.ok) throw new Error(`read_selection failed: ${res.status}`)
  return res.json() as Promise<SelectionResponse>
}

export async function readDraft(baseUrl: string, projectId: string): Promise<ReadDraftBlock[]> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/draft`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_draft failed: ${res.status}`)
  const { blocks } = (await res.json()) as { blocks: ReadDraftBlock[] }
  return blocks
}

export async function readCards(
  baseUrl: string,
  projectId: string,
  ids: string[],
): Promise<CardDigest[]> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_cards failed: ${res.status}`)
  const { cards } = (await res.json()) as { cards: CardDigest[] }
  return cards
}

export async function unfurlReference(
  baseUrl: string,
  projectId: string,
  url: string,
): Promise<Reference> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/unfurl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`unfurl failed: ${res.status}`)
  const { reference } = (await res.json()) as { reference: Reference }
  return reference
}

export async function listReviews(baseUrl: string, projectId: string): Promise<Review[]> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/reviews`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`list_reviews failed: ${res.status}`)
  const { reviews } = (await res.json()) as { reviews: Review[] }
  return reviews
}

/** Create a review; with `agent` set it is born in-progress (the ad-hoc pass). */
export async function postReview(
  baseUrl: string,
  projectId: string,
  args: { personality: PersonalityId; focus?: string | null; agent?: string | null },
): Promise<Review> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`create review failed: ${res.status} ${body}`.trim())
  }
  const { review } = (await res.json()) as { review: Review }
  return review
}

export async function postReviewStatus(
  baseUrl: string,
  projectId: string,
  reviewId: string,
  args: { status: ReviewStatus; agent?: string | null; verdict?: string | null },
): Promise<Review> {
  const res = await fetch(
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/status`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    },
  )
  if (res.status === 404) throw new Error(`unknown project or review — call list_reviews to see valid ids`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`review status change failed: ${res.status} ${body}`.trim())
  }
  const { review } = (await res.json()) as { review: Review }
  return review
}

export async function postChangeSet(
  baseUrl: string,
  projectId: string,
  cs: ChangeSet,
  fetchImpl: typeof fetch = globalThis.fetch,
  attemptTimeoutMs = 8_000,
): Promise<void> {
  const capturedChangeSetJson = JSON.stringify(cs)
  const projectUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}`
  const tokenUrl = `${projectUrl}/changeset-token`
  const changeSetUrl = `${projectUrl}/changeset?protocol=2`
  const refreshableCodes = new Set([
    'sequence-payload-mismatch',
    'epoch-mismatch',
    'sequence-ahead',
  ])
  const maxAttempts = 3
  const maxTokenRefreshes = 3

  type ChangeSetToken = { epoch: string; sequence: number }

  const isToken = (value: unknown): value is ChangeSetToken => {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.epoch === 'string'
      && candidate.epoch.length > 0
      && Number.isSafeInteger(candidate.sequence)
      && (candidate.sequence as number) >= 0
  }
  const errorDetail = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
  class AttemptFailure extends Error {
    constructor(message: string, readonly response?: Response) {
      super(message)
      this.name = 'AttemptFailure'
    }
  }
  const fetchAttempt = async (
    url: string,
    init?: RequestInit,
  ): Promise<{ response: Response; body: string }> => {
    const controller = new AbortController()
    const abort = () => {
      try { controller.abort() } catch { /* best effort */ }
    }
    let receivedResponse: Response | undefined
    const operation = (async () => {
      receivedResponse = await fetchImpl(url, { ...init, signal: controller.signal })
      try {
        const body = await receivedResponse.text()
        return { response: receivedResponse, body }
      } catch (error) {
        abort()
        throw new AttemptFailure(`response body unavailable: ${errorDetail(error)}`, receivedResponse)
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort()
        reject(new AttemptFailure(
          receivedResponse
            ? `response body unavailable: attempt timed out after ${attemptTimeoutMs}ms`
            : `attempt timed out after ${attemptTimeoutMs}ms`,
          receivedResponse,
        ))
      }, attemptTimeoutMs)
      const unref = (timer as { unref?: () => void }).unref
      if (typeof unref === 'function') unref.call(timer)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const responseCode = (body: string): string | undefined => {
    try {
      const parsed = JSON.parse(body) as unknown
      return typeof parsed === 'object'
        && parsed !== null
        && typeof (parsed as Record<string, unknown>).code === 'string'
        ? (parsed as Record<string, string>).code
        : undefined
    } catch {
      return undefined
    }
  }
  const attemptErrorDetail = (error: unknown): string =>
    error instanceof AttemptFailure && error.response
      ? `${error.response.status} ${error.message}`
      : errorDetail(error)
  const unknownProjectError = (body: string): Error =>
    new Error(
      `unknown project '${projectId}' — call list_projects to see valid ids${body ? `: ${body}` : ''}`,
    )
  const isRetryableServerStatus = (status: number): boolean =>
    status >= 500 && status <= 599 && status !== 507
  const isRetryableTokenBodyFailure = (response: Response): boolean =>
    response.ok || isRetryableServerStatus(response.status)
  const isAmbiguousPostBodyFailure = (response: Response): boolean =>
    response.status === 200 || response.status === 202 || isRetryableServerStatus(response.status)

  const acquireToken = async (): Promise<ChangeSetToken> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: Response
      let body: string
      try {
        const result = await fetchAttempt(tokenUrl)
        res = result.response
        body = result.body
      } catch (error) {
        if (error instanceof AttemptFailure && error.response &&
          !isRetryableTokenBodyFailure(error.response)) {
          const detail = attemptErrorDetail(error)
          if (error.response.status === 404) throw unknownProjectError(detail)
          throw new Error(`change-set token failed: ${detail}`)
        }
        if (attempt === maxAttempts) {
          throw new Error(
            `change-set token failed after ${maxAttempts} attempts: ${attemptErrorDetail(error)}`,
          )
        }
        continue
      }

      if (res.ok) {
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new Error(`change-set token failed: invalid response ${body}`.trim())
        }
        const token = typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).token
          : undefined
        if (!isToken(token)) {
          throw new Error(`change-set token failed: invalid response ${body}`.trim())
        }
        return token
      }

      if (res.status === 404) throw unknownProjectError(body)
      if (res.status >= 500 && res.status <= 599 && res.status !== 507 && attempt < maxAttempts) continue
      if (res.status >= 500 && res.status <= 599 && res.status !== 507) {
        throw new Error(
          `change-set token failed after ${maxAttempts} attempts: ${res.status} ${body}`.trim(),
        )
      }
      throw new Error(`change-set token failed: ${res.status} ${body}`.trim())
    }
    throw new Error('change-set token failed')
  }

  let token = await acquireToken()
  let tokenRefreshes = 0
  while (true) {
    const requestBody = `{"token":${JSON.stringify(token)},"changeSet":${capturedChangeSetJson}}`
    let response: Response | undefined
    let body = ''

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await fetchAttempt(changeSetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
        })
        response = result.response
        body = result.body
      } catch (error) {
        if (error instanceof AttemptFailure && error.response &&
          !isAmbiguousPostBodyFailure(error.response)) {
          const detail = attemptErrorDetail(error)
          if (error.response.status === 404) throw unknownProjectError(detail)
          throw new Error(`change-set rejected: ${detail}`)
        }
        if (attempt === maxAttempts) {
          throw new Error(
            `change-set post failed after ${maxAttempts} attempts: ${attemptErrorDetail(error)}`,
          )
        }
        continue
      }

      if (!isRetryableServerStatus(response.status)) break
      if (attempt === maxAttempts) {
        throw new Error(
          `change-set post failed after ${maxAttempts} attempts: ${response.status} ${body}`.trim(),
        )
      }
    }

    if (!response) throw new Error('change-set post failed')
    if (response.status === 200 || response.status === 202) return

    if (response.status === 404) throw unknownProjectError(body)
    const code = responseCode(body)
    if (response.status === 409 && code && refreshableCodes.has(code)) {
      if (tokenRefreshes === maxTokenRefreshes) {
        throw new Error(
          `change-set token refresh limit reached after ${maxTokenRefreshes} refreshes: ${response.status} ${body}`.trim(),
        )
      }
      tokenRefreshes += 1
      token = await acquireToken()
      continue
    }
    throw new Error(`change-set rejected: ${response.status} ${body}`.trim())
  }
}
