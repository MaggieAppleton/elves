import { afterEach, expect, test, vi } from 'vitest'
import {
  debounce,
  createSaver,
  loadCanvas,
  saveCanvas,
  listProjects,
  createProject,
  renameProject,
} from '../../src/client/persistence'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('loadCanvas GETs the project canvas and returns the parsed snapshot', async () => {
  const snap = { document: null, session: null }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snap })))
  expect(await loadCanvas('essay')).toEqual(snap)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/projects/essay/canvas'))
})

test('saveCanvas POSTs the snapshot to the project canvas as JSON', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  await saveCanvas('essay', { a: 1 })
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/projects/essay/canvas')
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual({ a: 1 })
  expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
})

test('listProjects GETs /projects', async () => {
  const projects = [{ id: 'essay', name: 'Essay', createdAt: 'now' }]
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => projects })))
  expect(await listProjects()).toEqual(projects)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/projects'))
})

test('createProject POSTs the name and returns the new project', async () => {
  const created = { id: 'new-essay', name: 'New Essay', createdAt: 'now' }
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => created }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await createProject('New Essay')).toEqual(created)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toMatch(/\/projects$/)
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual({ name: 'New Essay' })
})

test('renameProject PATCHes the project with the new name', async () => {
  const renamed = { id: 'essay', name: 'Final', createdAt: 'now' }
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => renamed }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await renameProject('essay', 'Final')).toEqual(renamed)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/projects/essay')
  expect(init.method).toBe('PATCH')
  expect(JSON.parse(init.body as string)).toEqual({ name: 'Final' })
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

test('debounce flush runs the pending trailing call immediately and cancels the timer', () => {
  // The fix for the note-blur truncation bug relies on this: on edit-end we must
  // force the pending autosave to fire NOW (before a resync re-fetches from the
  // server) rather than wait out the 500ms window, and it must not double-fire.
  vi.useFakeTimers()
  const spy = vi.fn()
  const d = debounce(spy, 500)
  d('a'); d('b')
  d.flush()
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('b')
  vi.advanceTimersByTime(500)
  expect(spy).toHaveBeenCalledTimes(1) // timer was cancelled by flush; no echo fire
})

test('debounce flush is a no-op when nothing is pending', () => {
  vi.useFakeTimers()
  const spy = vi.fn()
  const d = debounce(spy, 500)
  d.flush()
  expect(spy).not.toHaveBeenCalled()
})

test('createSaver whenIdle resolves only once the in-flight save settles', async () => {
  let resolveSave!: () => void
  const saveFn = vi.fn(() => new Promise<void>((r) => { resolveSave = r }))
  const saver = createSaver(saveFn)
  saver.request()
  let idle = false
  const waited = saver.whenIdle().then(() => { idle = true })
  await Promise.resolve()
  expect(idle).toBe(false) // save still in flight
  resolveSave()
  await waited
  expect(idle).toBe(true)
})

test('createSaver whenIdle waits out a queued (pendingDirty) save too', async () => {
  const resolvers: Array<() => void> = []
  const saveFn = vi.fn(() => new Promise<void>((r) => { resolvers.push(r) }))
  const saver = createSaver(saveFn)
  saver.request()
  saver.request() // arrives mid-flight → queued as pendingDirty
  let idle = false
  const waited = saver.whenIdle().then(() => { idle = true })
  resolvers[0]() // first save settles; the queued one now runs
  await Promise.resolve(); await Promise.resolve()
  expect(idle).toBe(false) // second save still in flight
  resolvers[1]()
  await waited
  expect(idle).toBe(true)
})

test('createSaver whenIdle resolves immediately when nothing is saving', async () => {
  const saver = createSaver(vi.fn(async () => {}))
  await expect(saver.whenIdle()).resolves.toBeUndefined()
})

test('loadCanvas throws when the response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
  await expect(loadCanvas('essay')).rejects.toThrow('load failed: 500')
})

test('saveCanvas throws when the response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
  await expect(saveCanvas('essay', { a: 1 })).rejects.toThrow('save failed: 500')
})

test('createSaver retries once more if a request comes in while a save is in flight, capturing the latest state', async () => {
  // Mirrors real usage: the "snapshot" is read synchronously at the moment
  // saveFn is invoked, then persisted asynchronously — so a request that
  // arrives mid-flight must trigger a second call reading the *newer* state.
  let state = 'first'
  const persisted: string[] = []
  let resolveFirst: () => void
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  let calls = 0
  const saveFn = vi.fn(() => {
    calls += 1
    const snapshot = state // captured synchronously at call time
    if (calls === 1) return first.then(() => { persisted.push(snapshot) })
    persisted.push(snapshot)
    return Promise.resolve()
  })
  const saver = createSaver(saveFn)

  saver.request()
  expect(saveFn).toHaveBeenCalledTimes(1)

  // A second edit arrives (state changes) while the first save is still in flight.
  state = 'latest'
  saver.request()
  expect(saveFn).toHaveBeenCalledTimes(1) // no overlapping call yet

  resolveFirst!()
  await first
  // let the .finally/retry microtasks flush
  await Promise.resolve()
  await Promise.resolve()

  expect(saveFn).toHaveBeenCalledTimes(2)
  expect(persisted).toEqual(['first', 'latest'])
})

test('createSaver does not retry when no request arrives during the in-flight save', async () => {
  const saveFn = vi.fn(async () => {})
  const saver = createSaver(saveFn)
  saver.request()
  await Promise.resolve()
  await Promise.resolve()
  expect(saveFn).toHaveBeenCalledTimes(1)
})

test('createSaver does not wedge when a save rejects: the error is swallowed and later requests still save', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  let reject: (err: unknown) => void
  const first = new Promise<void>((_, rej) => {
    reject = rej
  })
  const saveFn = vi.fn(() => (saveFn.mock.calls.length === 1 ? first : Promise.resolve()))
  const saver = createSaver(saveFn)

  saver.request()
  expect(saveFn).toHaveBeenCalledTimes(1)

  // The in-flight save rejects — a pendingDirty request queued mid-flight must
  // still flush on settle, proving saving=false is cleared even on rejection.
  saver.request()
  reject!(new Error('boom'))
  await first.catch(() => {}) // swallow so the rejection doesn't escape the test
  await Promise.resolve()
  await Promise.resolve()

  expect(errorSpy).toHaveBeenCalledWith('Elves: canvas save failed', expect.any(Error))
  // Flush from the pendingDirty retry happened despite the first save rejecting.
  expect(saveFn).toHaveBeenCalledTimes(2)

  // And the saver isn't stuck with saving=true forever: a fresh request saves again.
  saver.request()
  await Promise.resolve()
  expect(saveFn).toHaveBeenCalledTimes(3)
})
