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
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

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

test('a failed connection surfaces a reach-the-server error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }),
  )
  const events: AgentEvent[] = []
  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e)).done
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('could not reach the server') }])
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

  stream.close()
  await handle.done
})
