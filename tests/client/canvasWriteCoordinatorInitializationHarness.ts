import { vi } from 'vitest'
import type { DocumentRecords } from '../../src/client/canvasMerge'
import type {
  CanvasSnapshot,
  CanvasVersionedState,
  PendingChangeSetV2,
} from '../../src/client/persistence'
import { CanvasRevisionConflictError } from '../../src/client/persistence'
import {
  createCanvasWriteCoordinator,
  type CanvasWriteCoordinatorEditor,
  type CanvasWriteCoordinatorTransport,
} from '../../src/client/canvasWriteCoordinator'
import { CHANGE_SET_STAMP_META_KEY } from '../../src/model/changeset'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

export function document(name: string): DocumentRecords {
  return { page: { id: 'page', typeName: 'page', name } }
}

export function state(
  doc: DocumentRecords | null,
  revision: number,
  pendingChangeSets: PendingChangeSetV2[] = [],
): CanvasVersionedState {
  return {
    snapshot: { document: doc === null ? null : structuredClone(doc), session: { camera: revision } },
    revision,
    pendingChangeSets,
    nextChangeSetToken: { epoch: 'epoch-a', sequence: pendingChangeSets.length },
  }
}

export function conflict(revision: number): CanvasRevisionConflictError {
  return new CanvasRevisionConflictError('canvas revision conflict', 409, revision)
}

export const pendingNote: PendingChangeSetV2 = {
  token: { epoch: 'epoch-a', sequence: 1 },
  changeSet: {
    id: 'pending-note', author: 'agent',
    ops: [{ kind: 'create_note_card', text: 'A', x: 0, y: 0 }],
  },
}

export const pendingPair: PendingChangeSetV2 = {
  token: { epoch: 'epoch-a', sequence: 2 },
  changeSet: {
    id: 'pending-pair', author: 'agent',
    ops: [
      { kind: 'create_note_card', text: 'A', x: 0, y: 0 },
      { kind: 'create_section', text: 'B', x: 10, y: 10 },
    ],
  },
}

export function initHarness(options: {
  bootstrap?: DocumentRecords
  load?: CanvasWriteCoordinatorTransport['load']
  save?: CanvasWriteCoordinatorTransport['save']
} = {}) {
  const bootstrap = structuredClone(options.bootstrap ?? document('bootstrap'))
  let current = structuredClone(bootstrap)
  let session: unknown = { camera: 'bootstrap' }
  let applyCount = 0
  const readOnly = vi.fn()
  const loadInitialSnapshot = vi.fn((snapshot: CanvasSnapshot) => {
    if (snapshot.document !== null) current = structuredClone(snapshot.document as DocumentRecords)
    else current = structuredClone(bootstrap)
    session = structuredClone(snapshot.session)
  })
  const applyAcceptedChangeSet = vi.fn((entry: PendingChangeSetV2['changeSet'], stamp: string) => {
    for (const op of entry.ops) {
      applyCount += 1
      const id = `shape:${stamp}:${applyCount}`
      if (op.kind === 'create_section') {
        current[id] = {
          id, typeName: 'shape', type: 'section', props: {},
          meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
        }
      } else if (op.kind === 'create_question') {
        current[id] = {
          id, typeName: 'shape', type: 'question', props: {},
          meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
        }
      } else if (op.kind === 'create_figure_card') {
        current[id] = {
          id, typeName: 'shape', type: 'card', props: { kind: 'figure' },
          meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
        }
      } else if (op.kind === 'create_reference') {
        current[id] = {
          id, typeName: 'shape', type: 'card',
          props: { kind: 'note', noteKind: 'reference' },
          meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
        }
      } else if (op.kind === 'create_note_card') {
        current[id] = {
          id, typeName: 'shape', type: 'card',
          props: { kind: 'note', noteKind: 'text' },
          meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
        }
      }
    }
    return []
  })
  const load = vi.fn(options.load ?? (async () => state(document('remote'), 7)))
  const save = vi.fn(options.save ?? (async (_id, _snapshot, revision) => revision + 1))
  const remoteChanges = vi.fn()
  const editor = {
    setReadOnly: readOnly,
    loadInitialSnapshot,
    applyAcceptedChangeSet,
    captureSnapshot: () => ({
      document: structuredClone(current),
      session: structuredClone(session),
    }),
    captureDocument: () => structuredClone(current),
    normalizeDocument: (snapshot: CanvasSnapshot) =>
      structuredClone(snapshot.document as DocumentRecords),
    applyDocument: (next: DocumentRecords) => {
      current = structuredClone(next)
      return []
    },
    isEditing: () => false,
    onEditingEnd: () => () => {},
  } as CanvasWriteCoordinatorEditor
  const coordinator = createCanvasWriteCoordinator({
    projectId: 'essay', editor, transport: { load, save }, autosaveMs: 0,
    onRemoteChange: remoteChanges,
  })
  return {
    coordinator,
    load,
    save,
    readOnly,
    loadInitialSnapshot,
    applyAcceptedChangeSet,
    remoteChanges,
    get document() { return current },
    get session() { return session },
    setDocument(next: DocumentRecords) { current = structuredClone(next) },
  }
}
