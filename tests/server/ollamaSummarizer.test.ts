import { afterEach, expect, test, vi } from 'vitest'
import { OllamaSummarizer } from '../../server/summarize/ollama'

afterEach(() => vi.unstubAllGlobals())

test('close aborts an active summary request and refuses later work', async () => {
  let requestSignal: AbortSignal | undefined
  const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
  vi.stubGlobal('fetch', fetchMock)
  const summarizer = new OllamaSummarizer('http://ollama.test', 'test-model', 60_000)

  const active = summarizer.summarize('long note')
  await Promise.resolve()
  summarizer.close()

  await expect(active).resolves.toBeNull()
  expect(requestSignal?.aborted).toBe(true)
  await expect(summarizer.summarize('later note')).resolves.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
