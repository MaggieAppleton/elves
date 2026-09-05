import { expect, test } from 'vitest'
import {
  MemoryCanvasRecoveryStore,
  browserRecoverySessionId,
  createRecoveryEntry,
  recoveryKey,
} from '../../src/client/canvasRecovery'

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
