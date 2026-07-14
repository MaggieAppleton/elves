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

test('prepares the run id before posting the agent stream request', async () => {
  const calls: Array<{ path: string; body: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      path: new URL(String(url)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (String(url).endsWith('/agent/prepare')) {
      return new Response('{"ok":true}', { status: 200 })
    }
    return sseResponse(['event: end\ndata: {}\n\n'])
  }))

  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  await handle.done

  expect(calls.map((call) => call.path)).toEqual(['/agent/prepare', '/agent/run'])
  expect(calls[0].body).toEqual({ runId: handle.runId, projectId: 'p' })
  expect(calls[1].body.runId).toBe(handle.runId)
})

test('a non-ok response surfaces the server error message', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(new URL(String(url)).pathname)
    if (String(url).endsWith('/agent/prepare')) return new Response('{"ok":true}', { status: 200 })
    if (String(url).endsWith('/agent/run')) {
      return new Response(JSON.stringify({ error: 'an agent is already running' }), { status: 409 })
    }
    if (String(url).endsWith('/agent/abandon')) return new Response('{"ok":true}', { status: 200 })
    return new Response('{"active":false}', { status: 200 })
  }))
  const events: AgentEvent[] = []
  await runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e)).done
  expect(events).toEqual([{ type: 'error', message: 'an agent is already running' }])
  expect(calls).toContain('/agent/abandon')
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
    '/agent/prepare', '/agent/run', '/agent/abandon', expect.stringMatching(/^\/agent\/runs\//),
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
    if (String(url).endsWith('/agent/prepare')) return new Response('{"ok":true}', { status: 200 })
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
    if (String(url).endsWith('/agent/abandon')) {
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

test('requestCancel abandons the run UUID and marks the run request aborted', async () => {
  const stream = openSseResponse()
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/agent/abandon')) return new Response('{"ok":true}', { status: 200 })
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
  const cancelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/abandon'))
  const runBody = JSON.parse(String(runCall?.[1]?.body))
  const cancelBody = JSON.parse(String(cancelCall?.[1]?.body))
  expect(runBody.runId).toMatch(/^[0-9a-f-]{36}$/)
  expect(cancelBody).toEqual({ runId: runBody.runId })
  expect(runCall?.[1]?.signal).toMatchObject({ aborted: true })
  expect(settled).toBe(false)

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})

test('cancel aborts a held run request then waits for authoritative inactive settlement', async () => {
  vi.useFakeTimers()
  const runStarted = deferred<void>()
  const calls: string[] = []
  let runSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/agent/prepare') return new Response('{"ok":true}', { status: 200 })
    if (path === '/agent/run') {
      runSignal = init?.signal as AbortSignal | undefined
      runStarted.resolve()
      return new Promise<Response>((_resolve, reject) => {
        runSignal?.addEventListener('abort', () => reject(runSignal?.reason), { once: true })
      })
    }
    if (path === '/agent/abandon') return new Response('{"ok":true}', { status: 200 })
    if (path.startsWith('/agent/runs/')) return new Response('{"active":false}', { status: 200 })
    throw new Error(`unexpected URL: ${url}`)
  }))

  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (event) => events.push(event))
  let settled = false
  void handle.done.then(() => { settled = true })
  await runStarted.promise

  await handle.requestCancel()
  await handle.done

  expect(runSignal?.aborted).toBe(true)
  expect(settled).toBe(true)
  expect(calls).toEqual([
    '/agent/prepare', '/agent/run', '/agent/abandon', expect.stringMatching(/^\/agent\/runs\//),
  ])
  expect(events).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

test('requestCancel rejects with the server message when abandonment is not accepted', async () => {
  const stream = openSseResponse()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).endsWith('/agent/abandon')
      ? new Response(JSON.stringify({ error: 'could not signal the active agent run' }), { status: 409 })
      : String(url).endsWith('/agent/prepare')
        ? new Response('{"ok":true}', { status: 200 })
      : stream.response,
  ))
  const started = deferred<void>()
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (event) => {
    if (event.type === 'started') started.resolve()
  })
  stream.push('data: {"type":"started"}')
  await started.promise

  await expect(handle.requestCancel()).rejects.toThrow('could not signal the active agent run')

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})

test('cancel before prepare responds abandons the admission and never posts a run', async () => {
  const prepared = deferred<Response>()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/agent/prepare') return prepared.promise
    if (path === '/agent/abandon') return new Response('{"ok":true}', { status: 200 })
    throw new Error(`unexpected URL: ${url}`)
  }))

  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  const cancelled = handle.requestCancel()
  prepared.resolve(new Response('{"ok":true}', { status: 200 }))

  await cancelled
  await handle.done
  expect(calls).toEqual(['/agent/prepare', '/agent/abandon'])
})

test('cancel stops an offline prepare retry without waiting for its backoff', async () => {
  vi.useFakeTimers()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/agent/prepare') throw new TypeError('offline')
    if (path === '/agent/abandon') return new Response('{"ok":true}', { status: 200 })
    throw new Error(`unexpected URL: ${url}`)
  }))

  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  await vi.waitFor(() => expect(calls).toEqual(['/agent/prepare']))

  await handle.requestCancel()
  await handle.done
  expect(calls).toEqual(['/agent/prepare', '/agent/abandon'])
  expect(vi.getTimerCount()).toBe(0)
})

test('suppressCallbacks hides events but keeps observing the stream until it ends', async () => {
  const stream = openSseResponse()
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => stream.response)
  vi.stubGlobal('fetch', fetchMock)
  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  let settled = false
  void handle.done.then(() => { settled = true })

  handle.suppressCallbacks()
  stream.push('data: {"type":"text","text":"stale"}')
  await Promise.resolve()

  const runCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/run'))
  expect(runCall?.[1]?.signal).toBeUndefined()
  expect(settled).toBe(false)
  expect(events).toEqual([])

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done

  expect(events).toEqual([])
})

test('suppressCallbacks before the run response still observes the eventual stream', async () => {
  const response = deferred<Response>()
  const stream = openSseResponse()
  vi.stubGlobal('fetch', vi.fn(async () => response.promise))
  const events: AgentEvent[] = []
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  let settled = false
  void handle.done.then(() => { settled = true })

  handle.suppressCallbacks()
  response.resolve(stream.response)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  expect(settled).toBe(false)
  expect(events).toEqual([])

  stream.push('event: end\ndata: {}')
  stream.close()
  await handle.done
})

test('dispose then cancel makes one offline abandon attempt and leaves no lifecycle work', async () => {
  vi.useFakeTimers()
  const calls: string[] = []
  let abandonKeepalive: boolean | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/agent/prepare') throw new TypeError('offline')
    if (path === '/agent/abandon') {
      abandonKeepalive = init?.keepalive
      throw new TypeError('still offline')
    }
    throw new Error(`unexpected URL: ${url}`)
  }))

  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  await vi.waitFor(() => expect(calls).toEqual(['/agent/prepare']))
  handle.dispose()
  const cancelled = handle.requestCancel().catch(() => {})
  await vi.waitFor(() => expect(calls).toEqual(['/agent/prepare', '/agent/abandon']))

  expect(vi.getTimerCount()).toBe(0)
  await cancelled
  await handle.done
  await vi.advanceTimersByTimeAsync(60_000)
  expect(calls).toEqual(['/agent/prepare', '/agent/abandon'])
  expect(abandonKeepalive).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('suppressed mounted cancellation keeps retrying abandon fail-closed', async () => {
  vi.useFakeTimers()
  let abandonAttempts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/agent/prepare')) return new Response('{"ok":true}', { status: 200 })
    if (String(url).endsWith('/agent/run')) throw new TypeError('response lost')
    if (String(url).endsWith('/agent/abandon')) {
      abandonAttempts += 1
      if (abandonAttempts === 1) throw new TypeError('offline')
      return new Response('{"ok":true}', { status: 200 })
    }
    return new Response('{"active":false}', { status: 200 })
  }))

  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  handle.suppressCallbacks()
  const cancelled = handle.requestCancel()
  await vi.waitFor(() => expect(abandonAttempts).toBe(1))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersToNextTimerAsync()
  await cancelled
  await handle.done
  expect(abandonAttempts).toBe(2)
})
