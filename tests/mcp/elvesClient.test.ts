import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import type { ChangeSet } from '../../src/model/changeset'
import { postChangeSet } from '../../mcp/elvesClient'
import { createServer } from '../../server/app'
import { canvasPathFor, createProject } from '../../server/projects'
import { readCanvas, writeCanvas } from '../../server/store'
import {
  MAX_RECENT_CHANGE_SET_DIGESTS,
  consumeChangeSetSequence,
} from '../../server/canvasMetadata'
import { changeSetDigest } from '../../server/changeSetIdentity'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type FetchCall = { url: string; init?: RequestInit }

const TOKEN_A = { epoch: 'epoch-a', sequence: 7 }
const TOKEN_B = { epoch: 'epoch-b', sequence: 11 }

function changeSet(): ChangeSet {
  return {
    id: 'cs-fixed', author: 'claude',
    ops: [{ kind: 'create_note_card', text: 'Once', x: 1, y: 2 }],
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function scriptedFetch(
  steps: Array<Response | Error | ((call: FetchCall) => Response | Promise<Response>)>,
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (input, init) => {
    const call = { url: String(input), init }
    calls.push(call)
    const step = steps.shift()
    if (!step) throw new Error(`unexpected fetch ${call.url}`)
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(call) : step
  }
  return { fetch, calls }
}

function tokenResponse(token = TOKEN_A): Response {
  return json(200, { revision: 3, token })
}

function runWith(fetcher: FetchLike, cs = changeSet(), timeoutMs?: number): Promise<void> {
  vi.stubGlobal('fetch', fetcher)
  return postChangeSet('http://elves.test', 'essay', cs, fetcher as typeof fetch, timeoutMs)
}

async function settleWithin<T>(promise: Promise<T>, guardMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test guard exceeded ${guardMs}ms`)), guardMs)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function responseWithHangingBody(status: number): Response {
  const response = json(status, { ignored: true })
  vi.spyOn(response, 'text').mockImplementation(() => new Promise<string>(() => {}))
  return response
}

type BodyFailure = 'hanging' | 'rejecting'

function responseWithFailedBody(status: number, failure: BodyFailure): Response {
  if (failure === 'hanging') return responseWithHangingBody(status)
  const response = json(status, { ignored: true })
  vi.spyOn(response, 'text').mockRejectedValue(new Error('body read failed'))
  return response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('gets a token and posts the captured change-set through protocol 2', async () => {
  const cs = changeSet()
  const originalJson = JSON.stringify(cs)
  const scripted = scriptedFetch([
    (call) => {
      cs.id = 'mutated-after-capture'
      cs.ops = []
      return tokenResponse()
    },
    json(200, { ok: true, revision: 4, nextChangeSetToken: { ...TOKEN_A, sequence: 8 } }),
  ])

  await runWith(scripted.fetch, cs)

  expect(scripted.calls.map((call) => call.url)).toEqual([
    'http://elves.test/projects/essay/changeset-token',
    'http://elves.test/projects/essay/changeset?protocol=2',
  ])
  const posted = scripted.calls[1]
  expect(posted.init).toMatchObject({
    method: 'POST', headers: { 'content-type': 'application/json' },
  })
  expect(posted.init?.body).toBe(`{"token":${JSON.stringify(TOKEN_A)},"changeSet":${originalJson}}`)
})

test('a network failure before delivery retries the exact token and body', async () => {
  const scripted = scriptedFetch([
    tokenResponse(),
    new TypeError('connection reset before delivery'),
    json(200, { ok: true }),
  ])

  await runWith(scripted.fetch)

  const posts = scripted.calls.filter((call) => call.init?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[1].init?.body).toBe(posts[0].init?.body)
})

test('a duplicate with an evicted digest is success without a new token submission', async () => {
  const scripted = scriptedFetch([
    tokenResponse(),
    json(200, { ok: true, duplicate: true, payloadUnverified: true }),
  ])

  await runWith(scripted.fetch)

  expect(scripted.calls).toHaveLength(2)
})

test.each(['sequence-payload-mismatch', 'epoch-mismatch', 'sequence-ahead'])
('a proven %s conflict refreshes the token but retains the captured payload', async (code) => {
  const scripted = scriptedFetch([
    tokenResponse(TOKEN_A),
    json(409, { code, revision: 4, nextChangeSetToken: TOKEN_B }),
    tokenResponse(TOKEN_B),
    json(200, { ok: true }),
  ])

  await runWith(scripted.fetch)

  const posts = scripted.calls.filter((call) => call.init?.method === 'POST')
  expect(posts).toHaveLength(2)
  const first = JSON.parse(String(posts[0].init?.body))
  const second = JSON.parse(String(posts[1].init?.body))
  expect(first.token).toEqual(TOKEN_A)
  expect(second.token).toEqual(TOKEN_B)
  expect(second.changeSet).toEqual(first.changeSet)
  expect(second.changeSet.id).toBe('cs-fixed')
})

test.each([
  [400, { code: 'invalid-change-set', error: 'bad request' }],
  [409, { code: 'invalid-target', missing: ['shape:missing'] }],
  [507, { code: 'pending-full', error: 'pending-full' }],
  [507, { code: 'pending-too-large', error: 'pending-too-large' }],
  [507, { code: 'canvas-revision-exhausted', error: 'revision exhausted' }],
  [507, { code: 'changeset-sequence-exhausted', error: 'sequence exhausted' }],
])('POST %i fails with diagnostics and no retry', async (status, body) => {
  const scripted = scriptedFetch([tokenResponse(), json(status, body)])

  await expect(runWith(scripted.fetch)).rejects.toThrow(
    new RegExp(`change-set rejected: ${status}.*${String(body.code)}`),
  )
  expect(scripted.calls).toHaveLength(2)
})

test('unknown project preserves list_projects guidance and response diagnostics', async () => {
  const scripted = scriptedFetch([
    json(404, { error: 'unknown project', project: 'essay' }),
  ])

  await expect(runWith(scripted.fetch)).rejects.toThrow(
    /unknown project 'essay'.*list_projects.*unknown project/,
  )
  expect(scripted.calls).toHaveLength(1)
})

test('token GET retries network and 5xx failures up to a successful third attempt', async () => {
  const scripted = scriptedFetch([
    new TypeError('dns unavailable'),
    json(503, { error: 'restarting' }),
    tokenResponse(),
    json(202, { ok: true, pending: true }),
  ])

  await runWith(scripted.fetch)

  expect(scripted.calls.filter((call) => call.url.endsWith('/changeset-token'))).toHaveLength(3)
  expect(scripted.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1)
})

test('persistent token GET ambiguity stops after three attempts with a useful error', async () => {
  const scripted = scriptedFetch([
    json(500, { error: 'one' }),
    new TypeError('two'),
    json(503, { error: 'three' }),
  ])

  await expect(runWith(scripted.fetch)).rejects.toThrow(/change-set token failed.*3.*three/)
  expect(scripted.calls).toHaveLength(3)
})

test('token GET 507 fails immediately with response diagnostics', async () => {
  const scripted = scriptedFetch([
    json(507, { code: 'changeset-sequence-exhausted', error: 'sequence exhausted' }),
  ])

  await expect(runWith(scripted.fetch)).rejects.toThrow(
    /change-set token failed: 507.*changeset-sequence-exhausted/,
  )
  expect(scripted.calls).toHaveLength(1)
})

test.each([500, 502, 503])('token GET %i remains retryable and bounded', async (status) => {
  const scripted = scriptedFetch([
    json(status, { error: 'temporary-one' }),
    json(status, { error: 'temporary-two' }),
    tokenResponse(),
    json(200, { ok: true }),
  ])

  await runWith(scripted.fetch)

  expect(scripted.calls.filter((call) => call.url.endsWith('/changeset-token'))).toHaveLength(3)
})

test('a non-cooperative token fetch times out, aborts, and terminates after three attempts', async () => {
  const signals: AbortSignal[] = []
  let calls = 0
  const fetcher: FetchLike = async (_input, init) => {
    calls += 1
    signals.push(init?.signal as AbortSignal)
    return new Promise<Response>(() => {})
  }

  await expect(settleWithin(runWith(fetcher, changeSet(), 5))).rejects.toThrow(
    /change-set token failed after 3 attempts:.*timed out/,
  )
  expect(calls).toBe(3)
  expect(signals).toHaveLength(3)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test('a token success with a non-cooperative body times out and retries three times', async () => {
  const signals: AbortSignal[] = []
  let calls = 0
  const fetcher: FetchLike = async (_input, init) => {
    calls += 1
    signals.push(init?.signal as AbortSignal)
    return responseWithHangingBody(200)
  }

  await expect(settleWithin(runWith(fetcher, changeSet(), 5))).rejects.toThrow(
    /change-set token failed after 3 attempts:.*timed out/,
  )
  expect(calls).toBe(3)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test.each(
  (['hanging', 'rejecting'] as const).flatMap((failure) =>
    [404, 418, 507].map((status) => ({ failure, status }))),
)('token GET $status with a $failure body fails once from the definitive status', async ({
  failure,
  status,
}) => {
  const signals: AbortSignal[] = []
  let calls = 0
  const fetcher: FetchLike = async (_input, init) => {
    calls += 1
    signals.push(init?.signal as AbortSignal)
    return responseWithFailedBody(status, failure)
  }

  const error = await settleWithin(runWith(fetcher, changeSet(), 5)).then(
    () => null,
    (caught: Error) => caught,
  )

  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toContain(String(status))
  expect(error?.message).toMatch(/body.*(?:unavailable|failed|timed out)/)
  if (status === 404) expect(error?.message).toMatch(/unknown project.*list_projects/)
  else expect(error?.message).toMatch(/change-set token failed/)
  expect(calls).toBe(1)
  expect(signals).toHaveLength(1)
  expect(signals[0].aborted).toBe(true)
})

test.each([200, 503])('token GET %i with a rejected body remains safely retryable', async (status) => {
  let tokenCalls = 0
  const signals: AbortSignal[] = []
  const fetcher: FetchLike = async (input, init) => {
    if (String(input).endsWith('/changeset-token')) {
      tokenCalls += 1
      signals.push(init?.signal as AbortSignal)
      return tokenCalls === 1 ? responseWithFailedBody(status, 'rejecting') : tokenResponse()
    }
    return json(200, { ok: true })
  }

  await runWith(fetcher, changeSet(), 50)

  expect(tokenCalls).toBe(2)
  expect(signals[0].aborted).toBe(true)
})

test('an ambiguous POST fetch timeout retries the exact token and body', async () => {
  const postBodies: string[] = []
  const postSignals: AbortSignal[] = []
  const success = json(200, { ok: true })
  const successText = vi.spyOn(success, 'text')
  const fetcher: FetchLike = async (input, init) => {
    if (String(input).endsWith('/changeset-token')) return tokenResponse()
    postBodies.push(String(init?.body))
    postSignals.push(init?.signal as AbortSignal)
    if (postBodies.length === 1) return new Promise<Response>(() => {})
    return success
  }

  await settleWithin(runWith(fetcher, changeSet(), 5))

  expect(postBodies).toHaveLength(2)
  expect(postBodies[1]).toBe(postBodies[0])
  expect(postBodies.map((body) => JSON.parse(body).changeSet.id)).toEqual(['cs-fixed', 'cs-fixed'])
  expect(postSignals[0].aborted).toBe(true)
  expect(successText).toHaveBeenCalledOnce()
})

test('three non-cooperative POST 5xx bodies time out with one exact request body', async () => {
  const postBodies: string[] = []
  const postSignals: AbortSignal[] = []
  const fetcher: FetchLike = async (input, init) => {
    if (String(input).endsWith('/changeset-token')) return tokenResponse()
    postBodies.push(String(init?.body))
    postSignals.push(init?.signal as AbortSignal)
    return responseWithHangingBody(503)
  }

  await expect(settleWithin(runWith(fetcher, changeSet(), 5))).rejects.toThrow(
    /change-set post failed after 3 attempts:.*timed out/,
  )
  expect(postBodies).toHaveLength(3)
  expect(new Set(postBodies)).toHaveLength(1)
  expect(postSignals.every((signal) => signal.aborted)).toBe(true)
})

test.each(
  (['hanging', 'rejecting'] as const).flatMap((failure) =>
    [400, 404, 409, 507].map((status) => ({ failure, status }))),
)('POST $status with a $failure body fails once without token refresh', async ({
  failure,
  status,
}) => {
  let tokenGets = 0
  const postBodies: string[] = []
  const postSignals: AbortSignal[] = []
  const fetcher: FetchLike = async (input, init) => {
    if (String(input).endsWith('/changeset-token')) {
      tokenGets += 1
      return tokenResponse()
    }
    postBodies.push(String(init?.body))
    postSignals.push(init?.signal as AbortSignal)
    return responseWithFailedBody(status, failure)
  }

  const error = await settleWithin(runWith(fetcher, changeSet(), 5)).then(
    () => null,
    (caught: Error) => caught,
  )

  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toContain(String(status))
  expect(error?.message).toMatch(/body.*(?:unavailable|failed|timed out)/)
  if (status === 404) expect(error?.message).toMatch(/unknown project.*list_projects/)
  else expect(error?.message).toMatch(/change-set rejected/)
  expect(tokenGets).toBe(1)
  expect(postBodies).toHaveLength(1)
  expect(JSON.parse(postBodies[0]).changeSet.id).toBe('cs-fixed')
  expect(postSignals[0].aborted).toBe(true)
})

test.each([200, 202])('POST %i with a rejected body remains ambiguous and retries exactly', async (status) => {
  const postBodies: string[] = []
  const postSignals: AbortSignal[] = []
  const fetcher: FetchLike = async (input, init) => {
    if (String(input).endsWith('/changeset-token')) return tokenResponse()
    postBodies.push(String(init?.body))
    postSignals.push(init?.signal as AbortSignal)
    return postBodies.length === 1
      ? responseWithFailedBody(status, 'rejecting')
      : json(200, { ok: true })
  }

  await runWith(fetcher, changeSet(), 50)

  expect(postBodies).toHaveLength(2)
  expect(postBodies[1]).toBe(postBodies[0])
  expect(postSignals[0].aborted).toBe(true)
})

test('successful attempts consume both bodies and clear unrefed timers', async () => {
  const probe = setTimeout(() => {}, 1_000)
  const timerPrototype = Object.getPrototypeOf(probe)
  clearTimeout(probe)
  const unrefSpy = vi.spyOn(timerPrototype, 'unref')
  const setSpy = vi.spyOn(globalThis, 'setTimeout')
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
  const token = tokenResponse()
  const success = json(202, { ok: true, pending: true })
  const tokenText = vi.spyOn(token, 'text')
  const successText = vi.spyOn(success, 'text')
  const scripted = scriptedFetch([token, success])

  await runWith(scripted.fetch, changeSet(), 1_000)

  expect(tokenText).toHaveBeenCalledOnce()
  expect(successText).toHaveBeenCalledOnce()
  expect(setSpy).toHaveBeenCalledTimes(2)
  expect(unrefSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(clearSpy).toHaveBeenCalledTimes(2)
})

test('persistent ambiguous POST failure reuses one body and stops after three attempts', async () => {
  const scripted = scriptedFetch([
    tokenResponse(),
    new TypeError('one'),
    json(500, { error: 'two' }),
    new TypeError('three'),
  ])

  await expect(runWith(scripted.fetch)).rejects.toThrow(/change-set post failed.*3/)
  const posts = scripted.calls.filter((call) => call.init?.method === 'POST')
  expect(posts).toHaveLength(3)
  expect(new Set(posts.map((call) => call.init?.body))).toHaveLength(1)
})

test('POST ambiguity and token refresh limits are independent and bounded', async () => {
  let tokenNumber = 0
  let attemptForToken = 0
  const calls: FetchCall[] = []
  const fetcher: FetchLike = async (input, init) => {
    const call = { url: String(input), init }
    calls.push(call)
    if (call.url.endsWith('/changeset-token')) {
      attemptForToken = 0
      return tokenResponse({ epoch: 'epoch', sequence: tokenNumber++ })
    }
    attemptForToken += 1
    if (attemptForToken < 3) return json(500, { error: 'ambiguous' })
    return json(409, { code: 'sequence-ahead' })
  }

  await expect(runWith(fetcher)).rejects.toThrow(/token refresh.*3/)
  expect(calls.filter((call) => call.url.endsWith('/changeset-token'))).toHaveLength(4)
  expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(12)
  const ids = calls
    .filter((call) => call.init?.method === 'POST')
    .map((call) => JSON.parse(String(call.init?.body)).changeSet.id)
  expect(new Set(ids)).toEqual(new Set(['cs-fixed']))
})

let servers: http.Server[] = []
let dirs: string[] = []

async function startLiveProject() {
  const dataRoot = await fs.mkdtemp(join(tmpdir(), 'elves-client-'))
  dirs.push(dataRoot)
  await createProject(dataRoot, 'Essay', '2026-07-13T00:00:00.000Z')
  const app = createServer(dataRoot)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  servers.push(server)
  const { port } = server.address() as import('node:net').AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  const realFetch = globalThis.fetch
  await realFetch(`${baseUrl}/projects/essay/canvas`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: { store: { 'page:page': { id: 'page:page', typeName: 'page' } } },
      session: null,
    }),
  })
  const initial = await realFetch(`${baseUrl}/projects/essay/changeset-token`)
  const initialState = await initial.json() as {
    revision: number
    token: { epoch: string; sequence: number }
  }
  return {
    dataRoot,
    baseUrl,
    realFetch,
    canvasPath: canvasPathFor(dataRoot, 'essay')!,
    initialState,
  }
}

function cards(stored: any): any[] {
  return Object.values(stored.document.store)
    .filter((record: any) => record?.type === 'card')
}

function cardsWithText(stored: any, text: string): any[] {
  return cards(stored).filter((record: any) => record.props?.text === text)
}

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  dirs = []
})

test('a live applied success with an unreadable body times out and retries as a duplicate', async () => {
  const { baseUrl, realFetch, canvasPath, initialState } = await startLiveProject()
  const original = changeSet()
  const capturedJson = JSON.stringify(original)
  const postBodies: string[] = []
  const postSignals: AbortSignal[] = []
  const postResponses: any[] = []
  let duplicateText: ReturnType<typeof vi.spyOn> | undefined
  const unreadableFetch: FetchLike = async (input, init) => {
    const url = String(input)
    if (init?.method !== 'POST' || !url.endsWith('/changeset?protocol=2')) {
      return realFetch(input, init)
    }
    const attempt = postBodies.push(String(init.body))
    postSignals.push(init.signal as AbortSignal)
    const response = await realFetch(input, init)
    if (attempt === 1) {
      postResponses.push(JSON.parse(await response.text()))
      return responseWithHangingBody(response.status)
    }
    postResponses.push(await response.clone().json())
    duplicateText = vi.spyOn(response, 'text')
    return response
  }

  await settleWithin(
    postChangeSet(baseUrl, 'essay', original, unreadableFetch as typeof fetch, 100),
    1_000,
  )

  expect(postBodies).toEqual([
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
  ])
  expect(postBodies.map((body) => JSON.parse(body).changeSet.id)).toEqual(['cs-fixed', 'cs-fixed'])
  expect(postSignals[0].aborted).toBe(true)
  expect(duplicateText).toHaveBeenCalledOnce()
  expect(postResponses).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true, duplicate: true }),
  ])
  const finalState = await (await realFetch(`${baseUrl}/projects/essay/changeset-token`)).json() as any
  expect(finalState).toEqual({
    revision: initialState.revision + 1,
    token: { epoch: initialState.token.epoch, sequence: initialState.token.sequence + 1 },
  })
  const stored = await readCanvas(canvasPath)
  expect(cards(stored)).toHaveLength(1)
  expect(cardsWithText(stored, 'Once')).toHaveLength(1)
})

test('a live failure before delivery retries the exact body and applies once', async () => {
  const { baseUrl, realFetch, canvasPath, initialState } = await startLiveProject()
  const original = changeSet()
  const capturedJson = JSON.stringify(original)
  const postBodies: string[] = []
  let tokenGets = 0
  let forwardedPosts = 0
  const beforeDeliveryFetch: FetchLike = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/changeset-token')) tokenGets += 1
    if (init?.method === 'POST' && url.endsWith('/changeset?protocol=2')) {
      postBodies.push(String(init.body))
      if (postBodies.length === 1) throw new TypeError('failed before delivery')
      forwardedPosts += 1
    }
    return realFetch(input, init)
  }

  await postChangeSet(baseUrl, 'essay', original, beforeDeliveryFetch as typeof fetch)

  expect(tokenGets).toBe(1)
  expect(postBodies).toEqual([
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
  ])
  expect(postBodies.map((body) => JSON.parse(body).changeSet.id)).toEqual(['cs-fixed', 'cs-fixed'])
  expect(forwardedPosts).toBe(1)
  const finalState = await (await realFetch(`${baseUrl}/projects/essay/changeset-token`)).json() as any
  expect(finalState).toEqual({
    revision: initialState.revision + 1,
    token: { epoch: initialState.token.epoch, sequence: initialState.token.sequence + 1 },
  })
  const stored = await readCanvas(canvasPath)
  expect(cards(stored)).toHaveLength(1)
  expect(cardsWithText(stored, 'Once')).toHaveLength(1)
})

test('a live lost response after digest eviction remains an unverified non-executable duplicate', async () => {
  const { baseUrl, realFetch, canvasPath, initialState } = await startLiveProject()
  const original = changeSet()
  const capturedJson = JSON.stringify(original)
  const postBodies: string[] = []
  const postResponses: Array<{ status: number; body: any }> = []
  let tokenGets = 0
  const lossyEvictionFetch: FetchLike = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/changeset-token')) tokenGets += 1
    if (init?.method !== 'POST' || !url.endsWith('/changeset?protocol=2')) {
      return realFetch(input, init)
    }
    postBodies.push(String(init.body))
    const response = await realFetch(input, init)
    postResponses.push({ status: response.status, body: await response.clone().json() })
    if (postBodies.length === 1) {
      let advanced = await readCanvas(canvasPath)
      for (let index = 0; index < MAX_RECENT_CHANGE_SET_DIGESTS; index += 1) {
        advanced = consumeChangeSetSequence(
          advanced,
          changeSetDigest({ id: `advance-${index}`, author: 'claude', ops: [] }),
        )
      }
      await writeCanvas(canvasPath, advanced)
      throw new TypeError('response lost after digest eviction')
    }
    return response
  }

  await postChangeSet(baseUrl, 'essay', original, lossyEvictionFetch as typeof fetch)

  expect(tokenGets).toBe(1)
  expect(postBodies).toEqual([
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
  ])
  expect(postBodies.map((body) => JSON.parse(body).changeSet.id)).toEqual(['cs-fixed', 'cs-fixed'])
  expect(postResponses).toEqual([
    { status: 200, body: expect.objectContaining({ ok: true }) },
    {
      status: 200,
      body: expect.objectContaining({ ok: true, duplicate: true, payloadUnverified: true }),
    },
  ])
  const finalState = await (await realFetch(`${baseUrl}/projects/essay/changeset-token`)).json() as any
  expect(finalState).toEqual({
    revision: initialState.revision + MAX_RECENT_CHANGE_SET_DIGESTS + 1,
    token: {
      epoch: initialState.token.epoch,
      sequence: initialState.token.sequence + MAX_RECENT_CHANGE_SET_DIGESTS + 1,
    },
  })
  const stored = await readCanvas(canvasPath)
  expect(cards(stored)).toHaveLength(1)
  expect(cardsWithText(stored, 'Once')).toHaveLength(1)
})

test('a live producer race refreshes after payload mismatch and applies the original once', async () => {
  const { baseUrl, realFetch, canvasPath, initialState } = await startLiveProject()
  const original = changeSet()
  const capturedJson = JSON.stringify(original)
  const competitor = {
    id: 'cs-competitor', author: 'claude' as const,
    ops: [{ kind: 'create_note_card' as const, text: 'Competitor', x: 20, y: 20 }],
  }
  const clientPostBodies: string[] = []
  const competitorPostBodies: string[] = []
  const clientResponses: Array<{ status: number; body: any }> = []
  let clientTokenGets = 0
  let competitorPosts = 0
  const racingFetch: FetchLike = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/changeset-token')) clientTokenGets += 1
    if (init?.method !== 'POST' || !url.endsWith('/changeset?protocol=2')) {
      return realFetch(input, init)
    }
    clientPostBodies.push(String(init.body))
    if (clientPostBodies.length === 1) {
      const submitted = JSON.parse(String(init.body))
      competitorPosts += 1
      const competitorBody = JSON.stringify({ token: submitted.token, changeSet: competitor })
      competitorPostBodies.push(competitorBody)
      const competitorResponse = await realFetch(input, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: competitorBody,
      })
      expect(competitorResponse.status).toBe(200)
    }
    const response = await realFetch(input, init)
    clientResponses.push({ status: response.status, body: await response.clone().json() })
    return response
  }

  await postChangeSet(baseUrl, 'essay', original, racingFetch as typeof fetch)

  const refreshedToken = { epoch: initialState.token.epoch, sequence: initialState.token.sequence + 1 }
  expect(clientTokenGets).toBe(2)
  expect(competitorPosts).toBe(1)
  expect(clientPostBodies).toEqual([
    `{"token":${JSON.stringify(initialState.token)},"changeSet":${capturedJson}}`,
    `{"token":${JSON.stringify(refreshedToken)},"changeSet":${capturedJson}}`,
  ])
  expect(clientPostBodies.map((body) => JSON.parse(body).changeSet.id)).toEqual(['cs-fixed', 'cs-fixed'])
  expect(competitorPostBodies).toEqual([
    JSON.stringify({ token: initialState.token, changeSet: competitor }),
  ])
  expect(clientResponses).toEqual([
    {
      status: 409,
      body: expect.objectContaining({ code: 'sequence-payload-mismatch' }),
    },
    { status: 200, body: expect.objectContaining({ ok: true }) },
  ])
  const finalState = await (await realFetch(`${baseUrl}/projects/essay/changeset-token`)).json() as any
  expect(finalState).toEqual({
    revision: initialState.revision + 2,
    token: { epoch: initialState.token.epoch, sequence: initialState.token.sequence + 2 },
  })
  const stored = await readCanvas(canvasPath)
  expect(cards(stored)).toHaveLength(2)
  expect(cardsWithText(stored, 'Competitor')).toHaveLength(1)
  expect(cardsWithText(stored, 'Once')).toHaveLength(1)
})

test('an applied response lost across an app restart retries once and creates once', async () => {
  const dataRoot = await fs.mkdtemp(join(tmpdir(), 'elves-client-'))
  dirs.push(dataRoot)
  await createProject(dataRoot, 'Essay', '2026-07-13T00:00:00.000Z')
  let app = createServer(dataRoot)
  const server = http.createServer((req, res) => app(req, res))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  servers.push(server)
  const { port } = server.address() as import('node:net').AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  const realFetch = globalThis.fetch
  await realFetch(`${baseUrl}/projects/essay/canvas`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: { store: { 'page:page': { id: 'page:page', typeName: 'page' } } },
      session: null,
    }),
  })
  let postAttempts = 0
  const lossyFetch: FetchLike = async (input, init) => {
    const response = await realFetch(input, init)
    if (init?.method === 'POST' && String(input).includes('/changeset?protocol=2')) {
      postAttempts += 1
      if (postAttempts === 1) {
        app = createServer(dataRoot)
        throw new TypeError('response lost after delivery')
      }
    }
    return response
  }

  await postChangeSet(baseUrl, 'essay', changeSet(), lossyFetch as typeof fetch)

  expect(postAttempts).toBe(2)
  const stored = await readCanvas(canvasPathFor(dataRoot, 'essay')!) as any
  expect(Object.values(stored.document.store)
    .filter((record: any) => record?.type === 'card' && record.props?.text === 'Once'))
    .toHaveLength(1)
})
