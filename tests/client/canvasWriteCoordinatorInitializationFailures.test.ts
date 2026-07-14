import { expect, test, vi } from 'vitest'
import type { CanvasVersionedState } from '../../src/client/persistence'
import type { PendingChangeSetV2 } from '../../src/client/persistence'
import { CanvasRevisionConflictError } from '../../src/client/persistence'
import {
  CanvasPendingMaterializationError,
  CanvasWriteCoordinatorDisposedError,
} from '../../src/client/canvasWriteCoordinator'
import {
  CHANGE_SET_STAMP_META_KEY,
  changeSetTokenStamp,
} from '../../src/model/changeset'
import {
  conflict,
  deferred,
  document,
  initHarness,
  pendingNote,
  pendingPair,
  state,
  tick,
} from './canvasWriteCoordinatorInitializationHarness'

test.each(['load', 'apply', 'partial stamp', 'save'] as const)(
  '%s initialization failure stays read-only and retries from a fresh load',
  async (failure) => {
    const pending = failure === 'partial stamp' ? pendingPair : pendingNote
    let loadCount = 0
    const load = vi.fn(async () => {
      loadCount += 1
      if (failure === 'load' && loadCount === 1) throw new Error('load failed')
      return state(null, 1, [pending])
    })
    let saveCount = 0
    const save = vi.fn(async () => {
      saveCount += 1
      if (failure === 'save' && saveCount === 1) throw new Error('save failed')
      return 2
    })
    const h = initHarness({ load, save })
    if (failure === 'apply') {
      h.applyAcceptedChangeSet.mockImplementationOnce(() => {
        throw new Error('apply failed')
      })
    } else if (failure === 'partial stamp') {
      h.applyAcceptedChangeSet.mockImplementationOnce((_changeSet, stamp) => {
        h.setDocument({
          ...h.document,
          partial: {
            id: 'partial', typeName: 'shape', type: 'card',
            props: { kind: 'note', noteKind: 'text' },
            meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
          },
        })
        return []
      })
    }

    const first = h.coordinator.initialize()
    if (failure === 'partial stamp') {
      await expect(first).rejects.toBeInstanceOf(CanvasPendingMaterializationError)
    } else {
      await expect(first).rejects.toThrow(`${failure.split(' ')[0]} failed`)
    }
    expect(h.readOnly).toHaveBeenLastCalledWith(true)

    await h.coordinator.initialize()

    const stamp = changeSetTokenStamp(pending.token)
    const stamped = Object.values(h.document).filter((record) =>
      (record.meta as Record<string, unknown> | undefined)?.[CHANGE_SET_STAMP_META_KEY] === stamp)
    expect(stamped).toHaveLength(pending.changeSet.ops.length)
    expect(h.readOnly).toHaveBeenLastCalledWith(false)
  },
)

test('validates every pending token against the final staged document before saving', async () => {
  const second: PendingChangeSetV2 = {
    token: { epoch: 'epoch-a', sequence: 3 },
    changeSet: {
      id: 'second', author: 'agent',
      ops: [{ kind: 'create_section', text: 'B', x: 0, y: 0 }],
    },
  }
  const h = initHarness({ load: async () => state(null, 1, [pendingNote, second]) })
  let application = 0
  h.applyAcceptedChangeSet.mockImplementation((_changeSet, stamp) => {
    application += 1
    h.setDocument(application === 1
      ? {
          ...h.document,
          first: {
            id: 'first', typeName: 'shape', type: 'card',
            props: { kind: 'note', noteKind: 'text' },
            meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
          },
        }
      : {
          page: { id: 'page', typeName: 'page', name: 'bootstrap' },
          second: {
            id: 'second', typeName: 'shape', type: 'section', props: {},
            meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
          },
        })
    return []
  })

  await expect(h.coordinator.initialize()).rejects.toBeInstanceOf(
    CanvasPendingMaterializationError,
  )
  expect(h.save).not.toHaveBeenCalled()
  expect(h.readOnly).toHaveBeenLastCalledWith(true)
})

test('repeated materialization conflicts stop read-only and a later initialize retries', async () => {
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockResolvedValueOnce(state(null, 2, [pendingNote]))
    .mockResolvedValueOnce(state(null, 3, [pendingNote]))
  const save = vi.fn()
    .mockRejectedValueOnce(conflict(2))
    .mockRejectedValueOnce(conflict(3))
    .mockResolvedValueOnce(4)
  const h = initHarness({ load, save })

  await expect(h.coordinator.initialize()).rejects.toBeInstanceOf(
    CanvasRevisionConflictError,
  )
  expect(load).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenCalledTimes(2)
  expect(h.readOnly).toHaveBeenLastCalledWith(true)

  await h.coordinator.initialize()

  expect(load).toHaveBeenCalledTimes(3)
  expect(save).toHaveBeenCalledTimes(3)
  expect(h.readOnly).toHaveBeenLastCalledWith(false)
})

test('response loss after a committed materialization reloads without duplicating or resaving', async () => {
  const responseLost = new Error('response lost')
  let committed: CanvasVersionedState['snapshot'] | null = null
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockImplementationOnce(async () => state(
      committed!.document as ReturnType<typeof document>,
      2,
    ))
  const save = vi.fn(async (_projectId, snapshot: CanvasVersionedState['snapshot']) => {
    committed = structuredClone(snapshot)
    throw responseLost
  })
  const h = initHarness({ load, save })

  await expect(h.coordinator.initialize()).rejects.toBe(responseLost)
  expect(h.readOnly).toHaveBeenLastCalledWith(true)
  await h.coordinator.initialize()

  const stamp = changeSetTokenStamp(pendingNote.token)
  const stamped = Object.values(h.document).filter((record) =>
    (record.meta as Record<string, unknown> | undefined)?.[CHANGE_SET_STAMP_META_KEY] === stamp)
  expect(h.applyAcceptedChangeSet).toHaveBeenCalledTimes(1)
  expect(h.save).toHaveBeenCalledTimes(1)
  expect(stamped).toHaveLength(1)
  expect(h.readOnly).toHaveBeenLastCalledWith(false)
})

test('sync queued before initialize waits until pending materialization succeeds', async () => {
  const heldSave = deferred<number>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockResolvedValueOnce(state(document('synced'), 2))
  const h = initHarness({ load, save: () => heldSave.promise })

  const synced = h.coordinator.requestRemoteSync()
  const initialized = h.coordinator.initialize()
  await tick()
  expect(load).toHaveBeenCalledTimes(1)

  heldSave.resolve(2)
  await initialized
  await synced

  expect(load).toHaveBeenCalledTimes(2)
  expect(h.readOnly).toHaveBeenLastCalledWith(false)
})

test('failed initialization rejects and clears queued sync intent before retry', async () => {
  const failure = new Error('load failed')
  const load = vi.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(state(document('recovered'), 2))
  const h = initHarness({ load })
  const synced = h.coordinator.requestRemoteSync({ glow: true })

  await expect(h.coordinator.initialize()).rejects.toBe(failure)
  await expect(synced).rejects.toBe(failure)
  await h.coordinator.initialize()
  await tick()

  expect(load).toHaveBeenCalledTimes(2)
  expect(h.remoteChanges).not.toHaveBeenCalled()
})

test('dispose during an initialization load never applies or unlocks', async () => {
  const heldLoad = deferred<CanvasVersionedState>()
  const h = initHarness({ load: () => heldLoad.promise })
  const initialized = h.coordinator.initialize()

  h.coordinator.dispose()
  heldLoad.resolve(state(document('late'), 1))

  await expect(initialized).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(h.loadInitialSnapshot).not.toHaveBeenCalled()
  expect(h.readOnly.mock.calls).toEqual([[true]])
})

test('dispose during a materialization save never commits or unlocks', async () => {
  const heldSave = deferred<number>()
  const h = initHarness({
    load: async () => state(null, 1, [pendingNote]),
    save: () => heldSave.promise,
  })
  const initialized = h.coordinator.initialize()
  await tick()
  expect(h.save).toHaveBeenCalledTimes(1)

  h.coordinator.dispose()
  heldSave.resolve(2)

  await expect(initialized).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(h.readOnly.mock.calls).toEqual([[true]])
})

test('dispose before a save conflict rejection never starts a retry load', async () => {
  const heldSave = deferred<number>()
  const unexpectedRetry = deferred<CanvasVersionedState>()
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockImplementationOnce(() => unexpectedRetry.promise)
  const h = initHarness({ load, save: () => heldSave.promise })
  const initialized = h.coordinator.initialize()
  await tick()

  h.coordinator.dispose()
  heldSave.reject(conflict(2))
  await tick()
  unexpectedRetry.resolve(state(null, 2, [pendingNote]))

  await expect(initialized).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(load).toHaveBeenCalledTimes(1)
  expect(h.readOnly.mock.calls).toEqual([[true]])
})
