import { afterEach, expect, test, vi } from 'vitest'
import { runAnnotationThread } from '../../src/client/annotationThread'

const target = { kind: 'card' as const, cardId: 'shape:card', commentId: 'c1' }

afterEach(() => vi.unstubAllGlobals())

test('uses a durable user-message run identity and accepts an explicit SSE end frame', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(
    new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done","reply":"Saved."}\n\nevent: end\ndata: {}\n\n'))
      controller.close()
    } }),
  ))
  vi.stubGlobal('fetch', fetch)

  const run = runAnnotationThread('essay', target, 'user-1', vi.fn())
  await expect(run.done).resolves.toBeUndefined()
  expect(run.runId).toBe('annotation:user-1')
  expect(JSON.parse(fetch.mock.calls[0][1].body).runId).toBe('annotation:user-1')
})

test('rejects a premature SSE EOF so the durable message remains retryable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"text","text":"Partial"}\n\n'))
      controller.close()
    } }),
  )))

  await expect(runAnnotationThread('essay', target, 'user-1', vi.fn()).done)
    .rejects.toThrow('stream was interrupted')
})
