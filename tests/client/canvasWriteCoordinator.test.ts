import { afterEach, expect, test, vi } from 'vitest'
import type { CanvasSnapshot, CanvasVersionedState } from '../../src/client/persistence'
import { CanvasRevisionConflictError } from '../../src/client/persistence'
import type { DocumentRecords } from '../../src/client/canvasMerge'
import {
  CanvasWriteCoordinatorDisposedError,
  createCanvasWriteCoordinator,
  type CanvasWriteCoordinator,
  type CanvasWriteCoordinatorEditor,
  type CanvasWriteCoordinatorTransport,
  type CanvasWriteStatus,
} from '../../src/client/canvasWriteCoordinator'

afterEach(() => {
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function document(fields: Record<string, unknown> = {}): DocumentRecords {
  return {
    'page:page': { id: 'page:page', typeName: 'page', name: 'base', ...fields },
  }
}

function state(doc: DocumentRecords, revision: number): CanvasVersionedState {
  return {
    snapshot: { document: structuredClone(doc) },
    revision,
    pendingChangeSets: [],
    nextChangeSetToken: { epoch: 'epoch-a', sequence: 0 },
  }
}

function conflict(revision: number): CanvasRevisionConflictError {
  return new CanvasRevisionConflictError('canvas revision conflict', 409, revision)
}

function harness(options: {
  initial?: DocumentRecords
  load?: CanvasWriteCoordinatorTransport['load']
  save?: CanvasWriteCoordinatorTransport['save']
  autosaveMs?: number
  markDirtyOnApply?: boolean
} = {}) {
  let current = structuredClone(options.initial ?? document())
  let editing = false
  let editingEnd: (() => void) | null = null
  const statuses: CanvasWriteStatus[] = []
  const remoteChanges: Array<{ ids: string[]; glow: boolean }> = []
  const load = vi.fn(options.load ?? (async () => state(document(), 1)))
  const save = vi.fn(options.save ?? (async (_projectId, _snapshot, revision) => revision + 1))
  let coordinator!: CanvasWriteCoordinator
  const applyDocument = vi.fn((next: DocumentRecords) => {
    const ids = Object.keys(next).filter((id) =>
      JSON.stringify(current[id]) !== JSON.stringify(next[id]))
    current = structuredClone(next)
    if (options.markDirtyOnApply) coordinator.markDirty()
    return ids.sort()
  })
  const editor: CanvasWriteCoordinatorEditor = {
    captureSnapshot: () => ({ document: structuredClone(current) }),
    captureDocument: () => structuredClone(current),
    normalizeDocument: (snapshot: CanvasSnapshot) =>
      structuredClone(snapshot.document as DocumentRecords),
    applyDocument,
    isEditing: () => editing,
    onEditingEnd: (listener) => {
      editingEnd = listener
      return () => { editingEnd = null }
    },
  }
  coordinator = createCanvasWriteCoordinator({
    projectId: 'essay',
    editor,
    transport: { load, save },
    autosaveMs: options.autosaveMs ?? 0,
    onStatus: (status) => statuses.push(status),
    onRemoteChange: (ids, glow) => remoteChanges.push({ ids, glow }),
  })
  return {
    coordinator,
    load,
    save,
    applyDocument,
    statuses,
    remoteChanges,
    get document() { return current },
    setDocument(next: DocumentRecords) { current = structuredClone(next) },
    setEditing(next: boolean) {
      const wasEditing = editing
      editing = next
      if (wasEditing && !next) editingEnd?.()
    },
  }
}

test('an edit during a held save causes a fresh second save', async () => {
  const firstSave = deferred<number>()
  const save = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce(3)
  const h = harness({ save })
  await h.coordinator.initialize()
  expect(h.load).toHaveBeenCalledWith('essay')

  h.setDocument(document({ name: 'first edit' }))
  h.coordinator.markDirty()
  await tick()
  expect(save).toHaveBeenCalledTimes(1)

  h.setDocument(document({ name: 'latest edit' }))
  h.coordinator.markDirty()
  const flushed = h.coordinator.flushOrThrow()
  firstSave.resolve(2)
  await flushed

  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls.map((call) => call[0])).toEqual(['essay', 'essay'])
  expect((save.mock.calls[0][1] as CanvasSnapshot).document)
    .toEqual(document({ name: 'first edit' }))
  expect((save.mock.calls[1][1] as CanvasSnapshot).document)
    .toEqual(document({ name: 'latest edit' }))
  expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2])
})

test('a stale save fetches, recaptures live local, merges, applies, and retries', async () => {
  const conflictLoad = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => conflictLoad.promise)
    .mockResolvedValueOnce(state(document({ remoteOnly: true }), 2))
  const save = vi.fn()
    .mockRejectedValueOnce(conflict(2))
    .mockResolvedValueOnce(3)
  const h = harness({ load, save })
  await h.coordinator.initialize()

  h.setDocument(document({ name: 'local before fetch' }))
  h.coordinator.markDirty()
  const flushed = h.coordinator.flushOrThrow()
  await tick()
  expect(load).toHaveBeenCalledTimes(2)

  const appliesBeforeConflict = h.applyDocument.mock.calls.length
  h.setEditing(true)
  h.setDocument(document({ name: 'live local', localOnly: true }))
  h.coordinator.markDirty()
  conflictLoad.resolve(state(document({ remoteOnly: true }), 2))
  await tick()
  expect(h.applyDocument).toHaveBeenCalledTimes(appliesBeforeConflict)
  expect(save).toHaveBeenCalledTimes(1)

  h.setEditing(false)
  await flushed

  expect(load).toHaveBeenCalledTimes(3)
  expect(h.document['page:page']).toMatchObject({
    name: 'live local', localOnly: true, remoteOnly: true,
  })
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1][2]).toBe(2)
  expect((save.mock.calls[1][1] as CanvasSnapshot).document).toEqual(h.document)
  expect(h.remoteChanges.at(-1)).toEqual({ ids: ['page:page'], glow: false })
})

test('a second conflict stops, retains dirty work, and a later flush restarts', async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(conflict(2))
    .mockRejectedValueOnce(conflict(3))
    .mockResolvedValueOnce(4)
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockResolvedValueOnce(state(document({ remoteOnly: true }), 2))
  const h = harness({ load, save })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'local' }))
  h.coordinator.markDirty()

  await expect(h.coordinator.flushOrThrow()).rejects.toBeInstanceOf(
    CanvasRevisionConflictError,
  )
  expect(save).toHaveBeenCalledTimes(2)
  await tick()
  expect(save).toHaveBeenCalledTimes(2)

  await h.coordinator.flushOrThrow()
  expect(save).toHaveBeenCalledTimes(3)
  expect((save.mock.calls[2][1] as CanvasSnapshot).document).toEqual(h.document)
})

test('a save failure rejects its barrier and a later flush restarts retained dirty work', async () => {
  const failure = new Error('save offline')
  const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(2)
  const h = harness({ save })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'unsaved' }))
  h.coordinator.markDirty()

  await expect(h.coordinator.flushOrThrow()).rejects.toBe(failure)
  expect(save).toHaveBeenCalledTimes(1)
  await h.coordinator.flushOrThrow()
  expect(save).toHaveBeenCalledTimes(2)
})

test('a newer edit during a failing save restarts once with the latest snapshot', async () => {
  const firstSave = deferred<number>()
  const save = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockResolvedValueOnce(2)
  const h = harness({ save })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'first edit' }))
  h.coordinator.markDirty()
  await tick()

  h.setDocument(document({ name: 'latest edit' }))
  h.coordinator.markDirty()
  firstSave.reject(new Error('first save failed'))
  await tick()
  expect(save).toHaveBeenCalledTimes(2)
  await h.coordinator.flushOrThrow()

  expect((save.mock.calls[1][1] as CanvasSnapshot).document)
    .toEqual(document({ name: 'latest edit' }))
  await tick()
  expect(save).toHaveBeenCalledTimes(2)
})

test('the newer-edit restart consumes its debounce timer and stops after a second failure', async () => {
  vi.useFakeTimers()
  const firstSave = deferred<number>()
  const save = vi.fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockRejectedValueOnce(new Error('second save failed'))
    .mockResolvedValueOnce(3)
  const h = harness({ save, autosaveMs: 500 })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'first edit' }))
  h.coordinator.markDirty()
  await vi.advanceTimersByTimeAsync(500)
  expect(save).toHaveBeenCalledTimes(1)

  h.setDocument(document({ name: 'latest edit' }))
  h.coordinator.markDirty()
  firstSave.reject(new Error('first save failed'))
  await tick()
  expect(save).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(500)
  expect(save).toHaveBeenCalledTimes(2)
})

test('a fetch failure rejects sync and a later request restarts the pump', async () => {
  const failure = new Error('load offline')
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(state(document({ remoteOnly: true }), 2))
  const h = harness({ load })
  await h.coordinator.initialize()

  await expect(h.coordinator.requestRemoteSync()).rejects.toBe(failure)
  await h.coordinator.requestRemoteSync()

  expect(load).toHaveBeenCalledTimes(3)
  expect(h.document['page:page']).toMatchObject({ remoteOnly: true })
})

test('concurrent sync requests coalesce and combine glow intent', async () => {
  const held = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => held.promise)
  const h = harness({ load })
  await h.coordinator.initialize()
  h.setEditing(true)

  const first = h.coordinator.requestRemoteSync()
  const second = h.coordinator.requestRemoteSync({ glow: true })
  await tick()
  expect(load).toHaveBeenCalledTimes(1)
  h.setEditing(false)
  await tick()
  expect(load).toHaveBeenCalledTimes(2)
  held.resolve(state(document({ remoteOnly: true }), 2))
  await Promise.all([first, second])

  expect(load).toHaveBeenCalledTimes(2)
  expect(h.remoteChanges.at(-1)).toEqual({ ids: ['page:page'], glow: true })
})

test('sync requests arriving during a GET coalesce into one follow-up fetch', async () => {
  const held = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValueOnce(state(document({ remoteOnly: 'latest' }), 3))
  const h = harness({ load })
  await h.coordinator.initialize()

  const first = h.coordinator.requestRemoteSync()
  await tick()
  expect(load).toHaveBeenCalledTimes(2)
  const second = h.coordinator.requestRemoteSync({ glow: true })
  const third = h.coordinator.requestRemoteSync()
  held.resolve(state(document({ remoteOnly: 'stale' }), 2))
  await Promise.all([first, second, third])

  expect(load).toHaveBeenCalledTimes(3)
  expect(h.document['page:page']).toMatchObject({ remoteOnly: 'latest' })
  expect(h.remoteChanges.at(-1)).toEqual({ ids: ['page:page'], glow: true })
})

test('sync defers while editing and resumes from the editing-end subscription', async () => {
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockResolvedValueOnce(state(document({ remoteOnly: true }), 2))
  const save = vi.fn(async (_projectId: string, _snapshot: CanvasSnapshot, revision: number) => revision + 1)
  const h = harness({ load, save })
  await h.coordinator.initialize()
  h.setEditing(true)

  let settled = false
  const sync = h.coordinator.requestRemoteSync({ glow: true })
    .then(() => { settled = true })
  await tick()
  expect(load).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)

  h.setEditing(false)
  await sync
  expect(load).toHaveBeenCalledTimes(2)
  expect(save).not.toHaveBeenCalled()
  await h.coordinator.flushOrThrow()
  expect(save).not.toHaveBeenCalled()
})

test('sync refetches when editing begins during its request', async () => {
  const held = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValueOnce(state(document({ remoteOnly: 'latest' }), 3))
  const h = harness({ load })
  await h.coordinator.initialize()
  const appliesBeforeSync = h.applyDocument.mock.calls.length

  let settled = false
  const sync = h.coordinator.requestRemoteSync().then(() => { settled = true })
  await tick()
  h.setEditing(true)
  held.resolve(state(document({ remoteOnly: 'stale' }), 2))
  await tick()

  expect(h.applyDocument).toHaveBeenCalledTimes(appliesBeforeSync)
  expect(settled).toBe(false)
  h.setEditing(false)
  await sync
  expect(load).toHaveBeenCalledTimes(3)
  expect(h.document['page:page']).toMatchObject({ remoteOnly: 'latest' })
})

test('sync refetches when an entire edit cycle occurs during its request', async () => {
  const held = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValueOnce(state(document({ remoteOnly: 'latest' }), 3))
  const h = harness({ load })
  await h.coordinator.initialize()
  const appliesBeforeSync = h.applyDocument.mock.calls.length

  const sync = h.coordinator.requestRemoteSync()
  await tick()
  h.setEditing(true)
  h.setEditing(false)
  held.resolve(state(document({ remoteOnly: 'stale' }), 2))
  await sync

  expect(load).toHaveBeenCalledTimes(3)
  expect(h.applyDocument).toHaveBeenCalledTimes(appliesBeforeSync + 1)
  expect(h.document['page:page']).toMatchObject({ remoteOnly: 'latest' })
})

test('conflict recovery refetches after an edit cycle during its GET', async () => {
  const stale = deferred<CanvasVersionedState>()
  const latest = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => stale.promise)
    .mockImplementationOnce(() => latest.promise)
  const save = vi.fn().mockRejectedValueOnce(conflict(2)).mockResolvedValueOnce(4)
  const h = harness({ load, save })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'local before fetch' }))
  h.coordinator.markDirty()
  const flushed = h.coordinator.flushOrThrow()
  await tick()
  const appliesBeforeConflict = h.applyDocument.mock.calls.length

  h.setEditing(true)
  h.setDocument(document({ name: 'live local' }))
  h.coordinator.markDirty()
  h.setEditing(false)
  stale.resolve(state(document({ remoteOnly: 'stale' }), 2))
  await tick()

  expect(load).toHaveBeenCalledTimes(3)
  expect(h.applyDocument).toHaveBeenCalledTimes(appliesBeforeConflict)
  expect(save).toHaveBeenCalledTimes(1)
  latest.resolve(state(document({ remoteOnly: 'latest' }), 3))
  await flushed
  expect(h.document['page:page']).toMatchObject({ name: 'live local', remoteOnly: 'latest' })
})

test('remote apply cannot echo back through markDirty', async () => {
  const save = vi.fn(async (_projectId: string, _snapshot: CanvasSnapshot, revision: number) =>
    revision + 1)
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockResolvedValueOnce(state(document({ remoteOnly: true }), 2))
  const h = harness({ load, save, markDirtyOnApply: true })
  await h.coordinator.initialize()

  await h.coordinator.requestRemoteSync()
  await h.coordinator.flushOrThrow()

  expect(save).not.toHaveBeenCalled()
})

test('a null initial document preserves the live bootstrap document as base', async () => {
  const bootstrap = document({ name: 'bootstrap' })
  const load = vi.fn(async (_projectId: string): Promise<CanvasVersionedState> => ({
    ...state(document(), 0),
    snapshot: { document: null },
  }))
  const h = harness({ initial: bootstrap, load })

  await h.coordinator.initialize()

  expect(h.document).toEqual(bootstrap)
  expect(h.applyDocument).not.toHaveBeenCalled()
})

test('a sync requested during initialization queues a follow-up fetch', async () => {
  const initial = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockImplementationOnce(() => initial.promise)
    .mockResolvedValueOnce(state(document({ remoteOnly: 'latest' }), 2))
  const h = harness({ load })

  const initializing = h.coordinator.initialize()
  const sync = h.coordinator.requestRemoteSync({ glow: true })
    .then(() => 'resolved', (error: unknown) => error)
  initial.resolve(state(document({ remoteOnly: 'captured early' }), 1))
  await initializing

  expect(await sync).toBe('resolved')
  expect(load).toHaveBeenCalledTimes(2)
  expect(h.document['page:page']).toMatchObject({ remoteOnly: 'latest' })
})

test('initialization failure rejects sync barriers queued during the load', async () => {
  const initial = deferred<CanvasVersionedState>()
  const failure = new Error('initial load failed')
  const h = harness({ load: () => initial.promise })

  const initializing = h.coordinator.initialize()
  const sync = h.coordinator.requestRemoteSync()
    .then(() => null, (error: unknown) => error)
  initial.reject(failure)

  await expect(initializing).rejects.toBe(failure)
  expect(await sync).toBe(failure)
})

test('flush cancels a pending autosave timer and does not echo later', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_projectId: string, _snapshot: CanvasSnapshot, revision: number) => revision + 1)
  const h = harness({ save, autosaveMs: 500 })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'dirty' }))
  h.coordinator.markDirty()
  expect(save).not.toHaveBeenCalled()

  await h.coordinator.flushOrThrow()
  expect(save).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(save).toHaveBeenCalledTimes(1)
})

test('dispose cancels a pending autosave timer', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_projectId: string, _snapshot: CanvasSnapshot, revision: number) => revision + 1)
  const h = harness({ save, autosaveMs: 500 })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'dirty' }))
  h.coordinator.markDirty()

  h.coordinator.dispose()
  await vi.advanceTimersByTimeAsync(500)
  expect(save).not.toHaveBeenCalled()
})

test('dispose during initialize prevents stale apply and status publication', async () => {
  const held = deferred<CanvasVersionedState>()
  const h = harness({ load: () => held.promise, initial: document({ name: 'local' }) })
  const initialized = h.coordinator.initialize()
  expect(h.statuses).toEqual(['loading'])

  h.coordinator.dispose()
  held.resolve(state(document({ name: 'stale remote' }), 1))
  await expect(initialized).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(h.document).toEqual(document({ name: 'local' }))
  expect(h.statuses).toEqual(['loading'])
})

test('dispose during sync prevents stale remote apply and callback', async () => {
  const held = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(document(), 1))
    .mockImplementationOnce(() => held.promise)
  const h = harness({ load })
  await h.coordinator.initialize()
  const before = structuredClone(h.document)
  const changesBefore = h.remoteChanges.length

  const sync = h.coordinator.requestRemoteSync()
  await tick()
  h.coordinator.dispose()
  held.resolve(state(document({ remoteOnly: true }), 2))
  await expect(sync).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  await tick()

  expect(h.document).toEqual(before)
  expect(h.remoteChanges).toHaveLength(changesBefore)
  expect(h.statuses.at(-1)).toBe('syncing')
})

test('dispose during save rejects the barrier and prevents a stale idle status', async () => {
  const held = deferred<number>()
  const h = harness({ save: () => held.promise })
  await h.coordinator.initialize()
  h.setDocument(document({ name: 'dirty' }))
  h.coordinator.markDirty()
  const flushed = h.coordinator.flushOrThrow()
  await tick()
  expect(h.statuses.at(-1)).toBe('saving')

  h.coordinator.dispose()
  held.resolve(2)
  await expect(flushed).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  await tick()
  expect(h.statuses.at(-1)).toBe('saving')
})
