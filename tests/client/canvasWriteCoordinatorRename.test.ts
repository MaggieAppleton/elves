import { expect, test, vi } from 'vitest'
import { deferred, document, state, tick } from './canvasWriteCoordinatorInitializationHarness'
import { originalProject, renameHarness } from './canvasWriteCoordinatorRenameHarness'

test('flushes old identity, holds writes during PATCH, then rebinds and drains before resolving', async () => {
  const oldSave = deferred<number>()
  const patch = deferred<typeof originalProject>()
  const save = vi.fn()
    .mockImplementationOnce(() => oldSave.promise)
    .mockResolvedValueOnce(9)
  const h = renameHarness({ save, renameProject: () => patch.promise })
  await h.coordinator.initialize()
  expect(h.coordinator.ownsProject('draft')).toBe(true)

  h.setDocument(document('old edit'))
  h.coordinator.markDirty()
  await tick()
  const renamed = h.coordinator.renameProject('Final')
  await tick()
  expect(h.renameProject).not.toHaveBeenCalled()

  oldSave.resolve(8)
  await tick()
  expect(h.renameProject).toHaveBeenCalledWith('draft', 'Final')

  h.setDocument(document('edit during patch'))
  h.coordinator.markDirty()
  const synced = h.coordinator.requestRemoteSync({ glow: true })
  let externalFlushSettled = false
  const externalFlush = h.coordinator.flushOrThrow().then(() => { externalFlushSettled = true })
  await tick()
  expect(save).toHaveBeenCalledTimes(1)
  expect(externalFlushSettled).toBe(false)

  const finalProject = { ...originalProject, id: 'final', name: 'Final' }
  patch.resolve(finalProject)
  await expect(renamed).resolves.toEqual(finalProject)
  await externalFlush
  await synced

  expect(save.mock.calls.map((call) => [call[0], call[2]])).toEqual([
    ['draft', 7],
    ['final', 8],
  ])
  expect(save.mock.calls[1][1]).toEqual({ document: document('edit during patch') })
  expect(h.load.mock.calls.map((call) => call[0])).toEqual(['draft', 'final'])
  expect(h.coordinator.ownsProject('draft')).toBe(false)
  expect(h.coordinator.ownsProject('final')).toBe(true)
  expect(h.statuses).toContain('renaming')
  expect(h.statuses.at(-1)).toBe('idle')
})

test('supports a same-id metadata rename without a canvas save', async () => {
  const renamedProject = { ...originalProject, name: 'Draft!' }
  const h = renameHarness({
    renameProject: async () => renamedProject,
  })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Draft!')).resolves.toEqual(renamedProject)

  expect(h.renameProject).toHaveBeenCalledWith('draft', 'Draft!')
  expect(h.save).not.toHaveBeenCalled()
  expect(h.load.mock.calls.map((call) => call[0])).toEqual(['draft', 'draft'])
  expect(h.coordinator.ownsProject('draft')).toBe(true)
})

test('an immediate edit after starting rename is held for the new identity', async () => {
  const patch = deferred<unknown>()
  const finalProject = { ...originalProject, id: 'final', name: 'Final' }
  const h = renameHarness({ renameProject: () => patch.promise })
  await h.coordinator.initialize()

  const renamed = h.coordinator.renameProject('Final')
  h.setDocument(document('immediate edit'))
  h.coordinator.markDirty()
  await tick()

  expect(h.renameProject).toHaveBeenCalledWith('draft', 'Final')
  expect(h.save).not.toHaveBeenCalled()

  patch.resolve(finalProject)
  await expect(renamed).resolves.toEqual(finalProject)
  expect(h.save).toHaveBeenCalledWith(
    'final', { document: document('immediate edit') }, 7,
  )
})

test('an immediate sync after starting rename waits and loads the new identity', async () => {
  const patch = deferred<unknown>()
  const finalProject = { ...originalProject, id: 'final', name: 'Final' }
  const h = renameHarness({ renameProject: () => patch.promise })
  await h.coordinator.initialize()

  const renamed = h.coordinator.renameProject('Final')
  const synced = h.coordinator.requestRemoteSync()
  await tick()

  expect(h.renameProject).toHaveBeenCalledWith('draft', 'Final')
  expect(h.load.mock.calls.map((call) => call[0])).toEqual(['draft'])

  patch.resolve(finalProject)
  await expect(renamed).resolves.toEqual(finalProject)
  await synced
  expect(h.load.mock.calls.map((call) => call[0])).toEqual(['draft', 'final'])
})

test('a prior barrier reaction cannot start old-id work after rename closes the gate', async () => {
  const heldSync = deferred<ReturnType<typeof state>>()
  const patch = deferred<unknown>()
  const finalProject = { ...originalProject, id: 'final', name: 'Final' }
  let loadCount = 0
  const h = renameHarness({
    load: async () => {
      loadCount += 1
      return loadCount === 1 ? state(document('remote'), 7) : heldSync.promise
    },
    renameProject: () => patch.promise,
  })
  await h.coordinator.initialize()

  const priorSync = h.coordinator.requestRemoteSync().then(() => {
    h.setDocument(document('barrier edit'))
    h.coordinator.markDirty()
  })
  const renamed = h.coordinator.renameProject('Final')
  heldSync.resolve(state(document('remote'), 7))
  await tick()
  await tick()

  expect(h.save).not.toHaveBeenCalled()

  patch.resolve(finalProject)
  await priorSync
  await expect(renamed).resolves.toEqual(finalProject)
  expect(h.save).toHaveBeenCalledWith(
    'final', { document: document('barrier edit') }, 7,
  )
})
