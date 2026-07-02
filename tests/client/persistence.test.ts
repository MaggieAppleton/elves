import { afterEach, expect, test, vi } from 'vitest'
import {
  debounce,
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

test('loadCanvas throws when the response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
  await expect(loadCanvas('essay')).rejects.toThrow('load failed: 500')
})

test('saveCanvas throws when the response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
  await expect(saveCanvas('essay', { a: 1 })).rejects.toThrow('save failed: 500')
})
