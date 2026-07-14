import { expect, test, vi } from 'vitest'
import type { CanvasVersionedState, PendingChangeSetV2 } from '../../src/client/persistence'
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
  state,
  tick,
} from './canvasWriteCoordinatorInitializationHarness'

test('owns read-only state synchronously and unlocks after loading the full initial snapshot', async () => {
  const held = deferred<CanvasVersionedState>()
  const h = initHarness({ load: () => held.promise })

  expect(h.readOnly).toHaveBeenCalledTimes(1)
  expect(h.readOnly).toHaveBeenLastCalledWith(true)
  const initialized = h.coordinator.initialize()
  await tick()
  expect(h.readOnly).toHaveBeenCalledTimes(1)

  const remote = state(document('server'), 7)
  held.resolve(remote)
  await initialized

  expect(h.loadInitialSnapshot).toHaveBeenCalledWith(remote.snapshot)
  expect(h.document).toEqual(document('server'))
  expect(h.session).toEqual({ camera: 7 })
  expect(h.readOnly.mock.calls).toEqual([[true], [false]])
  expect(h.save).not.toHaveBeenCalled()

  h.setDocument(document('edited'))
  h.coordinator.markDirty()
  await h.coordinator.flushOrThrow()
  expect(h.save).toHaveBeenLastCalledWith(
    'essay', { document: document('edited'), session: { camera: 7 } }, 7,
  )
})

test('a null canvas materializes the editor bootstrap document before unlocking', async () => {
  const bootstrap = document('local bootstrap')
  const h = initHarness({ bootstrap, load: async () => state(null, 3) })

  await h.coordinator.initialize()

  expect(h.loadInitialSnapshot).toHaveBeenCalledWith(state(null, 3).snapshot)
  expect(h.document).toEqual(bootstrap)
  expect(h.session).toEqual({ camera: 3 })
  expect(h.save).toHaveBeenCalledWith(
    'essay', { document: bootstrap, session: { camera: 3 } }, 3,
  )
  expect(h.readOnly.mock.calls).toEqual([[true], [false]])
})

test('uses each pending token stamp in server order and saves before unlocking', async () => {
  const first: PendingChangeSetV2 = {
    token: { epoch: 'epoch-a', sequence: 1 },
    changeSet: {
      id: 'first', author: 'agent',
      ops: [{ kind: 'create_note_card', text: 'A', x: 0, y: 0 }],
    },
  }
  const second: PendingChangeSetV2 = {
    token: { epoch: 'epoch-a', sequence: 2 },
    changeSet: {
      id: 'second', author: 'agent',
      ops: [
        {
          kind: 'create_reference', x: 0, y: 0,
          reference: {
            url: 'https://example.com', refType: 'link', title: 'Example', authors: [],
            siteName: 'example.com', year: null, venue: null, description: null,
            faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
            fetchedBy: 'claude', fetchedAt: '2026-07-14T00:00:00.000Z',
          },
        },
        { kind: 'create_figure_card', title: 'Figure', description: 'Plan', x: 10, y: 0 },
        { kind: 'create_section', text: 'B', x: 20, y: 0 },
        { kind: 'create_question', text: 'Question?', x: 30, y: 0 },
      ],
    },
  }
  const heldSave = deferred<number>()
  const h = initHarness({
    load: async () => state(null, 5, [first, second]),
    save: () => heldSave.promise,
  })

  const initialized = h.coordinator.initialize()
  await tick()

  expect(h.applyAcceptedChangeSet.mock.calls.map((call) => call[1])).toEqual([
    changeSetTokenStamp(first.token),
    changeSetTokenStamp(second.token),
  ])
  expect(h.save).toHaveBeenCalledTimes(1)
  expect(h.save.mock.calls[0][2]).toBe(5)
  expect(h.readOnly.mock.calls).toEqual([[true]])

  heldSave.resolve(6)
  await initialized
  expect(h.readOnly.mock.calls).toEqual([[true], [false]])

  h.setDocument({ ...h.document, page: { id: 'page', typeName: 'page', name: 'edited' } })
  h.coordinator.markDirty()
  await h.coordinator.flushOrThrow()
  expect(h.save.mock.calls[1][2]).toBe(6)
})

test('a materialization conflict reloads and resets before reapplying pending work', async () => {
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockResolvedValueOnce(state(null, 2, [pendingNote]))
  const save = vi.fn()
    .mockRejectedValueOnce(conflict(2))
    .mockResolvedValueOnce(3)
  const h = initHarness({ load, save })

  await h.coordinator.initialize()

  const stamp = changeSetTokenStamp(pendingNote.token)
  const stamped = Object.values(h.document).filter((record) =>
    (record.meta as Record<string, unknown> | undefined)?.[CHANGE_SET_STAMP_META_KEY] === stamp)
  expect(load).toHaveBeenCalledTimes(2)
  expect(h.loadInitialSnapshot).toHaveBeenCalledTimes(2)
  expect(h.applyAcceptedChangeSet).toHaveBeenCalledTimes(2)
  expect(save.mock.calls.map((call) => call[2])).toEqual([1, 2])
  expect(stamped).toHaveLength(1)
  expect(h.readOnly.mock.calls).toEqual([[true], [false]])
})

test('a conflict reload accepts another client materialization without local duplicates', async () => {
  const stamp = changeSetTokenStamp(pendingNote.token)
  const remote = {
    ...document('remote'),
    remoteShape: {
      id: 'remoteShape', typeName: 'shape' as const, type: 'card',
      props: { kind: 'note', noteKind: 'text' },
      meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
    },
  }
  const load = vi.fn()
    .mockResolvedValueOnce(state(null, 1, [pendingNote]))
    .mockResolvedValueOnce(state(remote, 2))
  const save = vi.fn().mockRejectedValueOnce(conflict(2))
  const h = initHarness({ load, save })

  await h.coordinator.initialize()

  const stamped = Object.values(h.document).filter((record) =>
    (record.meta as Record<string, unknown> | undefined)?.[CHANGE_SET_STAMP_META_KEY] === stamp)
  expect(h.loadInitialSnapshot).toHaveBeenCalledTimes(2)
  expect(h.applyAcceptedChangeSet).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(stamped.map((record) => record.id)).toEqual(['remoteShape'])
  expect(h.readOnly.mock.calls).toEqual([[true], [false]])
})
