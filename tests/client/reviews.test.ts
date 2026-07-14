import { afterEach, expect, test, vi } from 'vitest'
import type { Review } from '../../src/model/reviews'
import { dismissReview, retryReview, summonReview } from '../../src/client/reviews'

const review = (overrides: Partial<Review> = {}): Review => ({
  id: 'rev-client-a',
  personality: 'trimmer',
  status: 'pending',
  focus: null,
  requestedAt: '2026-07-14T12:00:00.000Z',
  agent: null,
  startedAt: null,
  completedAt: null,
  verdict: null,
  commentCount: 0,
  error: null,
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('summon retries an ambiguous response with one stable review id', async () => {
  vi.useFakeTimers()
  const bodies: any[] = []
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) throw new TypeError('response lost')
    return new Response(JSON.stringify({ review: review({ id: bodies[0].reviewId }) }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)

  const result = summonReview('essay', 'trimmer', null)
  void result.catch(() => {})
  await vi.waitFor(() => expect(bodies).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(250)

  await expect(result).resolves.toMatchObject({ id: bodies[0].reviewId })
  expect(bodies[0].reviewId).toMatch(/^rev-[0-9a-f-]{36}$/)
  expect(bodies[1]).toEqual(bodies[0])
})

test('retry retries a 5xx response with one stable attempt id', async () => {
  vi.useFakeTimers()
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : {})
    if (bodies.length === 1) return new Response('lost upstream', { status: 503 })
    return new Response(JSON.stringify({
      review: review({ status: 'pending', attemptId: bodies[0].attemptId }),
    }), { status: 202 })
  }))

  const result = retryReview('essay', 'rev-client-a')
  void result.catch(() => {})
  await vi.waitFor(() => expect(bodies).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(250)

  await expect(result).resolves.toMatchObject({ attemptId: bodies[0].attemptId })
  expect(bodies[0].attemptId).toMatch(/^attempt-[0-9a-f-]{36}$/)
  expect(bodies[1]).toEqual(bodies[0])
})

test('dismiss retries an ambiguous response with one stable mutation id', async () => {
  vi.useFakeTimers()
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) throw new TypeError('response lost')
    return new Response(JSON.stringify({ review: review({ status: 'dismissed' }) }), { status: 200 })
  }))

  const result = dismissReview('essay', 'rev-client-a')
  void result.catch(() => {})
  await vi.waitFor(() => expect(bodies).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(250)

  await expect(result).resolves.toMatchObject({ status: 'dismissed' })
  expect(bodies[0].mutationId).toMatch(/^dismiss-[0-9a-f-]{36}$/)
  expect(bodies[1]).toEqual(bodies[0])
})

test('a truncated success body retries with the same mutation id', async () => {
  vi.useFakeTimers()
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) return new Response('{"review":', { status: 200 })
    return new Response(JSON.stringify({ review: review({ status: 'dismissed' }) }), { status: 200 })
  }))

  const result = dismissReview('essay', 'rev-client-a')
  void result.catch(() => {})
  await vi.waitFor(() => expect(bodies).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(250)

  await expect(result).resolves.toMatchObject({ status: 'dismissed' })
  expect(bodies[1]).toEqual(bodies[0])
})
