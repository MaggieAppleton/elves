import { expect, test, vi } from 'vitest'
import {
  MemoryCanvasRecoveryStore,
  browserRecoverySessionId,
  createBrowserRecoveryOwnership,
  createRecoveryEntry,
  recoveryKey,
} from '../../src/client/canvasRecovery'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
}

function recoveryBrowser(
  sessionId: string,
  localStorage: MemoryStorage,
): Window & { emitPagehide(): void } {
  const values = new Map([['elves:canvas-recovery-session-v1', sessionId]])
  const pagehideListeners = new Set<(event: Event) => void>()
  let ids = 0
  return {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    },
    crypto: { randomUUID: () => `rotated-${++ids}` },
    navigator: {},
    localStorage,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') pagehideListeners.add(listener)
    },
    emitPagehide: () => {
      for (const listener of pagehideListeners) listener(new Event('pagehide'))
    },
  } as unknown as Window & { emitPagehide(): void }
}

const entry = (sessionId: string, generation: number) => createRecoveryEntry({
  serverOrigin: 'http://localhost:5199',
  storageId: 'storage-one',
  projectId: 'essay',
  sessionId,
  generation,
  createdAt: '2026-09-05T12:00:00.000Z',
  updatedAt: `2026-09-05T12:00:0${generation}.000Z`,
  baseRevision: 1,
  baseEpoch: 'epoch-a',
  baseDocument: {},
  localDocument: {},
  localSnapshot: { document: {} },
})

test('recovery entries are isolated per server, project storage identity, and tab', async () => {
  const store = new MemoryCanvasRecoveryStore()
  await store.put(entry('tab-a', 1))
  await store.put(entry('tab-b', 2))
  expect(recoveryKey('http://localhost:5199', 'storage-one', 'tab-a'))
    .not.toBe(recoveryKey('http://localhost:5199', 'storage-one', 'tab-b'))
  expect((await store.list('http://localhost:5199', 'storage-one')).map((value) => value.sessionId))
    .toEqual(['tab-b', 'tab-a'])
  expect(await store.list('http://elsewhere', 'storage-one')).toEqual([])
})

test('conditional cleanup cannot delete a newer generation', async () => {
  const store = new MemoryCanvasRecoveryStore()
  await store.put(entry('tab-a', 2))
  const key = recoveryKey('http://localhost:5199', 'storage-one', 'tab-a')
  await expect(store.deleteIfGeneration(key, 1)).resolves.toBe(false)
  await expect(store.deleteIfGeneration(key, 2)).resolves.toBe(true)
})

test('the browser session identity survives reload without merging another tab', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  let ids = 0
  const cryptoSource = { randomUUID: () => `session-${++ids}` as `${string}-${string}-${string}-${string}-${string}` }
  expect(browserRecoverySessionId(storage, cryptoSource)).toBe('session-1')
  expect(browserRecoverySessionId(storage, cryptoSource)).toBe('session-1')
  expect(browserRecoverySessionId({ getItem: () => null, setItem: () => {} }, cryptoSource)).toBe('session-2')
})

test('a no-Web-Locks lease protects a live tab without asynchronous liveness', async () => {
  const localStorage = new MemoryStorage()
  const active = createBrowserRecoveryOwnership(recoveryBrowser('active-tab', localStorage))
  await active.ready
  const fresh = createBrowserRecoveryOwnership(recoveryBrowser('fresh-tab', localStorage))
  await fresh.ready

  expect(await fresh.activeSessionIds?.()).toEqual(new Set(['active-tab', 'fresh-tab']))
})

test('a no-Web-Locks lease is released on normal close so a fresh session can claim recovery', async () => {
  const localStorage = new MemoryStorage()
  const closedBrowser = recoveryBrowser('closed-tab', localStorage)
  const closed = createBrowserRecoveryOwnership(closedBrowser)
  await closed.ready
  closedBrowser.emitPagehide()
  const fresh = createBrowserRecoveryOwnership(recoveryBrowser('fresh-tab', localStorage))
  await fresh.ready

  expect(await fresh.activeSessionIds?.()).toEqual(new Set(['fresh-tab']))
})

test('a no-Web-Locks lease expires after an unclean close so recovery can proceed', async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'))
    const localStorage = new MemoryStorage()
    const crashed = createBrowserRecoveryOwnership(recoveryBrowser('crashed-tab', localStorage))
    await crashed.ready
    vi.setSystemTime(new Date('2026-09-05T12:05:01.000Z'))
    const fresh = createBrowserRecoveryOwnership(recoveryBrowser('fresh-tab', localStorage))
    await fresh.ready

    expect(await fresh.activeSessionIds?.()).toEqual(new Set(['fresh-tab']))
    expect(localStorage.getItem('elves:canvas-recovery-lease-v1:crashed-tab')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
