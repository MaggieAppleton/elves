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

test('cancel POSTs to the cancel endpoint', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith('/agent/cancel')
      ? new Response('{"ok":true}', { status: 200 })
      : sseResponse(['data: {"type":"started"}\n\nevent: end\ndata: {}\n\n']),
  )
  vi.stubGlobal('fetch', fetchMock)
  const handle = runAgent({ prompt: 'x', projectId: 'p', hasSelection: false }, () => {})
  await handle.done
  handle.cancel()
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/agent/cancel'), { method: 'POST' })
})
