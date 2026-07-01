import { afterEach, expect, test, vi } from 'vitest'
import { debounce, loadCanvas, saveCanvas } from '../../src/client/persistence'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('loadCanvas GETs and returns the parsed snapshot', async () => {
  const snap = { document: null, session: null }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snap })))
  expect(await loadCanvas()).toEqual(snap)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/canvas'))
})

test('saveCanvas POSTs the snapshot as JSON', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  await saveCanvas({ a: 1 })
  const [, init] = fetchMock.mock.calls[0]
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body)).toEqual({ a: 1 })
})

test('debounce collapses rapid calls into one trailing call', () => {
  vi.useFakeTimers()
  const spy = vi.fn()
  const d = debounce(spy, 500)
  d('a'); d('b'); d('c')
  expect(spy).not.toHaveBeenCalled()
  vi.advanceTimersByTime(500)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('c')
})
