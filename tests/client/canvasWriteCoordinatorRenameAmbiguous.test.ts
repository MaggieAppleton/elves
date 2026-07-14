import { expect, test, vi } from 'vitest'
import {
  CanvasRenameAmbiguousError,
  CanvasWriteCoordinatorDisposedError,
} from '../../src/client/canvasWriteCoordinator'
import { deferred, document, tick } from './canvasWriteCoordinatorInitializationHarness'
import { originalProject, renameHarness } from './canvasWriteCoordinatorRenameHarness'

const committed = { ...originalProject, id: 'report', name: 'Report' }

test('ambiguous identity persistently blocks ownership, saves, sync, switch flush, and other names', async () => {
  const failure = new Error('rename failed')
  const h = renameHarness({
    renameProject: async () => { throw failure },
    listProjects: async () => [],
  })
  await h.coordinator.initialize()

  const error = await h.coordinator.renameProject('Report').catch((caught) => caught)
  expect(error).toBeInstanceOf(CanvasRenameAmbiguousError)
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
  expect(h.coordinator.ownsProject('draft')).toBe(false)

  h.setDocument(document('blocked edit'))
  h.coordinator.markDirty()
  let flushResult: unknown
  let syncResult: unknown
  void h.coordinator.flushOrThrow().catch((caught) => { flushResult = caught })
  void h.coordinator.requestRemoteSync({ glow: true }).catch((caught) => { syncResult = caught })
  await tick()

  expect(flushResult).toBe(error)
  expect(syncResult).toBe(error)
  await expect(h.coordinator.renameProject('Other')).rejects.toBe(error)
  expect(h.save).not.toHaveBeenCalled()
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
  expect(h.renameProject).toHaveBeenCalledTimes(1)
  expect(h.listProjects).toHaveBeenCalledTimes(1)
})

test('a later same-name call retries reconciliation without another initial PATCH', async () => {
  const retryList = deferred<unknown>()
  const list = vi.fn()
    .mockResolvedValueOnce([])
    .mockImplementationOnce(() => retryList.promise)
  const h = renameHarness({
    renameProject: async () => { throw new Error('response lost') },
    listProjects: list,
  })
  await h.coordinator.initialize()
  await expect(h.coordinator.renameProject('Report')).rejects.toBeInstanceOf(
    CanvasRenameAmbiguousError,
  )

  const retrying = h.coordinator.renameProject('Report')
  await tick()
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
  retryList.resolve([committed])
  await expect(retrying).resolves.toEqual(committed)

  expect(h.renameProject).toHaveBeenCalledTimes(1)
  expect(h.listProjects).toHaveBeenCalledTimes(2)
  expect(h.coordinator.ownsProject('report')).toBe(true)
})

test('barriers queued during PATCH reject together when reconciliation is ambiguous', async () => {
  const patch = deferred<unknown>()
  const h = renameHarness({
    renameProject: () => patch.promise,
    listProjects: async () => [],
  })
  await h.coordinator.initialize()
  const renaming = h.coordinator.renameProject('Report')
  await tick()
  const syncing = h.coordinator.requestRemoteSync()
  const switching = h.coordinator.flushOrThrow()

  patch.reject(new Error('rename failed'))
  const error = await renaming.catch((caught) => caught)

  expect(error).toBeInstanceOf(CanvasRenameAmbiguousError)
  await expect(syncing).rejects.toBe(error)
  await expect(switching).rejects.toBe(error)
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
})

test('a repeated partial move exhausts one repair and becomes ambiguous', async () => {
  const partial = { ...originalProject, id: 'report-2' }
  const rename = vi.fn().mockRejectedValue(new Error('failed'))
  const list = vi.fn().mockResolvedValue([partial])
  const h = renameHarness({ renameProject: rename, listProjects: list })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Report')).rejects.toBeInstanceOf(
    CanvasRenameAmbiguousError,
  )

  expect(h.renameProject.mock.calls).toEqual([
    ['draft', 'Report'],
    ['report-2', 'Report'],
  ])
  expect(h.listProjects).toHaveBeenCalledTimes(2)
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
})

test.each([
  ['list failure', async () => { throw new Error('list failed') }],
  ['duplicate identity', async () => [originalProject, { ...originalProject, id: 'copy' }]],
  ['invalid project', async () => [{ id: 'draft', name: 'Draft' }]],
  ['unknown state', async () => [{ ...originalProject, id: 'moved', name: 'Unexpected' }]],
] as const)('%s becomes rename-ambiguous', async (_label, listProjects) => {
  const h = renameHarness({
    renameProject: async () => { throw new Error('rename failed') },
    listProjects,
  })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Report')).rejects.toBeInstanceOf(
    CanvasRenameAmbiguousError,
  )
  expect(h.statuses.at(-1)).toBe('rename-ambiguous')
})

test('same-name concurrent renames coalesce while a different name is rejected', async () => {
  const patch = deferred<unknown>()
  const h = renameHarness({ renameProject: () => patch.promise })
  await h.coordinator.initialize()

  const first = h.coordinator.renameProject('Report')
  const second = h.coordinator.renameProject('Report')
  expect(second).toBe(first)
  await expect(h.coordinator.renameProject('Other')).rejects.toMatchObject({
    name: 'CanvasRenameInProgressError',
  })

  patch.resolve(committed)
  await expect(first).resolves.toEqual(committed)
})

test('dispose invalidates held PATCH and list continuations', async () => {
  const patch = deferred<unknown>()
  const list = deferred<unknown>()
  const h = renameHarness({ renameProject: () => patch.promise, listProjects: () => list.promise })
  await h.coordinator.initialize()
  const renaming = h.coordinator.renameProject('Report')
  await tick()
  patch.reject(new Error('failed'))
  await tick()
  expect(h.listProjects).toHaveBeenCalledTimes(1)

  h.coordinator.dispose()
  list.resolve([committed])

  await expect(renaming).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(h.coordinator.ownsProject('draft')).toBe(false)
  expect(h.coordinator.ownsProject('report')).toBe(false)
})

test('dispose during a held successful PATCH never rebinds', async () => {
  const patch = deferred<unknown>()
  const h = renameHarness({ renameProject: () => patch.promise })
  await h.coordinator.initialize()
  const renaming = h.coordinator.renameProject('Report')
  await tick()

  h.coordinator.dispose()
  patch.resolve(committed)

  await expect(renaming).rejects.toBeInstanceOf(CanvasWriteCoordinatorDisposedError)
  expect(h.listProjects).not.toHaveBeenCalled()
  expect(h.save).not.toHaveBeenCalled()
})
