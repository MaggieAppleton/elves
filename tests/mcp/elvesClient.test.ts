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

function runWith(fetcher: FetchLike, cs = changeSet()): Promise<void> {
  vi.stubGlobal('fetch', fetcher)
  return postChangeSet('http://elves.test', 'essay', cs, fetcher as typeof fetch)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('gets a token and posts the captured change-set through protocol 2', async () => {
  const cs = changeSet()
  const originalJson = JSON.stringify(cs)
  const scripted = scriptedFetch([
    (call) => {
      cs.id = 'mutated-after-capture'
      cs.ops = []
      expect(call.init).toBeUndefined()
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
    if (!init) {
      attemptForToken = 0
      return tokenResponse({ epoch: 'epoch', sequence: tokenNumber++ })
    }
    attemptForToken += 1
    if (attemptForToken < 3) return json(500, { error: 'ambiguous' })
    return json(409, { code: 'sequence-ahead' })
  }

  await expect(runWith(fetcher)).rejects.toThrow(/token refresh.*3/)
  expect(calls.filter((call) => !call.init)).toHaveLength(4)
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
