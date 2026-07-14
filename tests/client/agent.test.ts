import { afterEach, expect, test, vi } from 'vitest'
import { runAgent, type AgentEvent } from '../../src/client/agent'

// Build a streaming SSE Response, optionally splitting a frame across chunks to
// prove the client's buffering joins them.
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function openSseResponse() {
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (frame: string) => controller.enqueue(enc.encode(`${frame}\n\n`)),
    close: () => controller.close(),
    fail: () => controller.error(new Error('connection lost')),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('decodes SSE frames into events, joining a frame split across chunks', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      sseResponse([
        'data: {"type":"started"}\n\ndata: {"type":"text","te',
        'xt":"hi"}\n\ndata: {"type":"tool","name":"read_map","summary":""}\n\n',
        'data: {"type":"done","reply":"done"}\n\nevent: end\ndata: {}\n\n',
      ]),
    ),
  )
  const events: AgentEvent[] = []
  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e)).done
  expect(events).toEqual([
    { type: 'started' },
    { type: 'text', text: 'hi' },
    { type: 'tool', name: 'read_map', summary: '' },
    { type: 'done', reply: 'done' },
  ])
})

test('a non-ok response surfaces the server error message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'an agent is already running' }), { status: 409 })),
  )
  const events: AgentEvent[] = []
  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e)).done
  expect(events).toEqual([{ type: 'error', message: 'an agent is already running' }])
})

test('a 5xx initial response abandons before done settles', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    if (String(url).endsWith('/agent/run')) return new Response('upstream lost response', { status: 503 })
    if (String(url).endsWith('/agent/abandon')) return new Response('{"ok":true}', { status: 200 })
    return new Response('{"active":false}', { status: 200 })
  }))

  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {}).done

  expect(calls.map((url) => new URL(url).pathname)).toEqual([
    '/agent/run', '/agent/abandon', expect.stringMatching(/^\/agent\/runs\//),
  ])
})

test('a failed connection surfaces a reach-the-server error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/agent/run')) throw new TypeError('Failed to fetch')
      if (String(url).endsWith('/agent/abandon')) return new Response('{"ok":true}', { status: 200 })
      return new Response('{"active":false}', { status: 200 })
    }),
  )
  const events: AgentEvent[] = []
  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e)).done
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('could not reach the server') }])
})

test('a rejected initial POST abandons atomically before done can settle', async () => {
  vi.useFakeTimers()
  let abandonAttempts = 0
  let statusChecks = 0
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/agent/run')) throw new TypeError('response lost')
    if (String(url).endsWith('/agent/abandon')) {
      abandonAttempts += 1
      if (abandonAttempts === 1) throw new TypeError('still offline')
      return new Response('{"ok":true}', { status: 200 })
    }
    if (String(url).includes('/agent/runs/')) {
      statusChecks += 1
      return new Response('{"active":false}', { status: 200 })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  let settled = false
  void handle.done.then(() => { settled = true })

  await vi.waitFor(() => expect(abandonAttempts).toBe(1))
  expect(settled).toBe(false)
  expect(statusChecks).toBe(0)

  await vi.advanceTimersByTimeAsync(250)
  await handle.done
  expect(abandonAttempts).toBe(2)
  expect(statusChecks).toBe(1)
})

test('an interrupted stream stays active until the server confirms that run is inactive', async () => {
  vi.useFakeTimers()
  const stream = openSseResponse()
  let statusChecks = 0
  let cancelRequests = 0
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/agent/cancel')) {
      cancelRequests += 1
      return new Response('{"ok":true}', { status: 200 })
    }
    if (String(url).includes('/agent/runs/')) {
      statusChecks += 1
      return new Response(JSON.stringify({ active: statusChecks === 1 }), { status: 200 })
    }
    return stream.response
  })
  vi.stubGlobal('fetch', fetchMock)
  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (event) => events.push(event))
  let settled = false
  void handle.done.then(() => { settled = true })

  stream.push('data: {"type":"started"}')
  await Promise.resolve()
  stream.fail()
  await vi.waitFor(() => expect(statusChecks).toBe(1))

  expect(settled).toBe(false)
  expect(events.at(-1)).toEqual({ type: 'error', message: 'the agent stream was interrupted' })
  await handle.requestCancel()
  expect(cancelRequests).toBe(1)

  await vi.advanceTimersByTimeAsync(250)
  await handle.done
  expect(statusChecks).toBe(2)
  vi.useRealTimers()
})

test('requestCancel sends the run UUID without aborting the stream or settling done', async () => {
  const stream = openSseResponse()
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/agent/cancel')) return new Response('{"ok":true}', { status: 200 })
    return stream.response
  })
  vi.stubGlobal('fetch', fetchMock)
  const started = deferred<void>()
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => {
    if (e.type === 'started') started.resolve()
  })
  let settled = false
  void handle.done.then(() => { settled = true })
  stream.push('data: {"type":"started"}')
  await started.promise

  await handle.requestCancel()

  const runCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/run'))
  const cancelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/cancel'))
  const runBody = JSON.parse(String(runCall?.[1]?.body))
  const cancelBody = JSON.parse(String(cancelCall?.[1]?.body))
  expect(runBody.runId).toMatch(/^[0-9a-f-]{36}$/)
  expect(cancelBody).toEqual({ runId: runBody.runId })
  expect(runCall?.[1]?.signal).toBeUndefined()
  expect(settled).toBe(false)

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})

test('requestCancel rejects with the server message when cancellation is not accepted', async () => {
  const stream = openSseResponse()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).endsWith('/agent/cancel')
      ? new Response(JSON.stringify({ error: 'could not signal the active agent run' }), { status: 503 })
      : stream.response,
  ))
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})

  await expect(handle.requestCancel()).rejects.toThrow('could not signal the active agent run')

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})

test('dispose suppresses callbacks but keeps observing the stream until it ends', async () => {
  const stream = openSseResponse()
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => stream.response)
  vi.stubGlobal('fetch', fetchMock)
  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  let settled = false
  void handle.done.then(() => { settled = true })

  handle.dispose()
  stream.push('data: {"type":"text","text":"stale"}')
  await Promise.resolve()

  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined()
  expect(settled).toBe(false)
  expect(events).toEqual([])

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done

  expect(events).toEqual([])
})

test('dispose before the run response still observes the eventual stream until it ends', async () => {
  const response = deferred<Response>()
  const stream = openSseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => response.promise))
  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  let settled = false
  void handle.done.then(() => { settled = true })

  handle.dispose()
  response.resolve(stream.response)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(settled).toBe(false)
  expect(events).toEqual([])

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})
