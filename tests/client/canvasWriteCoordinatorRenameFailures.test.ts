import { expect, test, vi } from 'vitest'
import { deferred, document, tick } from './canvasWriteCoordinatorInitializationHarness'
import { originalProject, renameHarness } from './canvasWriteCoordinatorRenameHarness'

const committedProject = { ...originalProject, id: 'report-2', name: 'Report' }

test('adopts a committed rename after the PATCH response is lost', async () => {
  const responseLost = new Error('response lost')
  const h = renameHarness({
    renameProject: async () => { throw responseLost },
    listProjects: async () => [committedProject],
  })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Report')).resolves.toEqual(committedProject)

  expect(h.listProjects).toHaveBeenCalledTimes(1)
  expect(h.save).not.toHaveBeenCalled()
  expect(h.coordinator.ownsProject('report-2')).toBe(true)
})

test('does not trust a malformed successful response without reconciliation', async () => {
  const h = renameHarness({
    renameProject: async () => ({ ...committedProject, createdAt: 'wrong identity' }),
    listProjects: async () => [committedProject],
  })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Report')).resolves.toEqual(committedProject)

  expect(h.listProjects).toHaveBeenCalledTimes(1)
  expect(h.coordinator.ownsProject('report-2')).toBe(true)
})

test('a definite rollback drains PATCH-window edits under the old id then rejects the original error', async () => {
  const patch = deferred<unknown>()
  const failure = new Error('rename failed')
  const h = renameHarness({
    renameProject: () => patch.promise,
    listProjects: async () => [originalProject],
  })
  await h.coordinator.initialize()

  const renaming = h.coordinator.renameProject('Report')
  await tick()
  h.setDocument(document('edit during failed patch'))
  h.coordinator.markDirty()
  patch.reject(failure)

  await expect(renaming).rejects.toBe(failure)

  expect(h.listProjects).toHaveBeenCalledTimes(1)
  expect(h.save).toHaveBeenCalledWith(
    'draft', { document: document('edit during failed patch') }, 7,
  )
  expect(h.coordinator.ownsProject('draft')).toBe(true)
})

test('repairs a partial move at its discovered collision id and reconciles once', async () => {
  const failure = new Error('rename failed')
  const partial = { ...originalProject, id: 'report-2' }
  const rename = vi.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(committedProject)
  const list = vi.fn()
    .mockResolvedValueOnce([partial])
    .mockResolvedValueOnce([committedProject])
  const h = renameHarness({ renameProject: rename, listProjects: list })
  await h.coordinator.initialize()

  await expect(h.coordinator.renameProject('Report')).resolves.toEqual(committedProject)

  expect(h.renameProject.mock.calls).toEqual([
    ['draft', 'Report'],
    ['report-2', 'Report'],
  ])
  expect(h.listProjects).toHaveBeenCalledTimes(2)
  expect(h.coordinator.ownsProject('report-2')).toBe(true)
})

test('pre-PATCH flush failure keeps old ownership, publishes error, and remains retryable', async () => {
  const heldSave = deferred<number>()
  const saveFailure = new Error('old save failed')
  const save = vi.fn()
    .mockImplementationOnce(() => heldSave.promise)
    .mockResolvedValueOnce(8)
  const h = renameHarness({ save })
  await h.coordinator.initialize()
  h.setDocument(document('unsaved old edit'))
  h.coordinator.markDirty()
  await tick()

  const renaming = h.coordinator.renameProject('Report')
  heldSave.reject(saveFailure)
  await expect(renaming).rejects.toBe(saveFailure)

  expect(h.renameProject).not.toHaveBeenCalled()
  expect(h.listProjects).not.toHaveBeenCalled()
  expect(h.coordinator.ownsProject('draft')).toBe(true)
  expect(h.statuses.at(-1)).toBe('error')

  await h.coordinator.flushOrThrow()
  expect(h.save.mock.calls.map((call) => call[0])).toEqual(['draft', 'draft'])
})

test('committed rebind with failed new-id drain surfaces identity and retries under new id', async () => {
  const patch = deferred<unknown>()
  const saveFailure = new Error('new save failed')
  const save = vi.fn()
    .mockRejectedValueOnce(saveFailure)
    .mockResolvedValueOnce(8)
  const h = renameHarness({ save, renameProject: () => patch.promise })
  await h.coordinator.initialize()
  const renaming = h.coordinator.renameProject('Report')
  await tick()
  h.setDocument(document('new identity edit'))
  h.coordinator.markDirty()
  patch.resolve(committedProject)

  await expect(renaming).rejects.toMatchObject({
    name: 'CanvasRenameCommittedDrainError',
    project: committedProject,
    cause: saveFailure,
  })
  expect(h.coordinator.ownsProject('report-2')).toBe(true)
  expect(h.statuses.at(-1)).toBe('error')

  await h.coordinator.flushOrThrow()
  expect(h.save.mock.calls.map((call) => call[0])).toEqual(['report-2', 'report-2'])
})

test('rolled-back old-id drain failure preserves both errors and retries under old id', async () => {
  const patch = deferred<unknown>()
  const renameFailure = new Error('rename failed')
  const saveFailure = new Error('rollback drain failed')
  const save = vi.fn()
    .mockRejectedValueOnce(saveFailure)
    .mockResolvedValueOnce(8)
  const h = renameHarness({
    save,
    renameProject: () => patch.promise,
    listProjects: async () => [originalProject],
  })
  await h.coordinator.initialize()
  const renaming = h.coordinator.renameProject('Report')
  await tick()
  h.setDocument(document('old identity edit'))
  h.coordinator.markDirty()
  patch.reject(renameFailure)

  await expect(renaming).rejects.toMatchObject({
    name: 'CanvasRenameRollbackDrainError',
    project: originalProject,
    renameError: renameFailure,
    saveError: saveFailure,
  })
  expect(h.coordinator.ownsProject('draft')).toBe(true)
  expect(h.statuses.at(-1)).toBe('error')

  await h.coordinator.flushOrThrow()
  expect(h.save.mock.calls.map((call) => call[0])).toEqual(['draft', 'draft'])
})
