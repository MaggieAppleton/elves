import { expect, test, vi } from 'vitest'
import { deferred, document, tick } from './canvasWriteCoordinatorInitializationHarness'
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
  let externalFlushSettled = false
  const externalFlush = h.coordinator.flushOrThrow().then(() => { externalFlushSettled = true })
  await tick()
  expect(save).toHaveBeenCalledTimes(1)
  expect(externalFlushSettled).toBe(false)

  const finalProject = { ...originalProject, id: 'final', name: 'Final' }
  patch.resolve(finalProject)
  await expect(renamed).resolves.toEqual(finalProject)
  await externalFlush

  expect(save.mock.calls.map((call) => [call[0], call[2]])).toEqual([
    ['draft', 7],
    ['final', 8],
  ])
  expect(save.mock.calls[1][1]).toEqual({ document: document('edit during patch') })
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
  expect(h.coordinator.ownsProject('draft')).toBe(true)
})
