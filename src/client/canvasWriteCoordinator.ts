import {
  mergeCanvasRecords,
  type CanvasMergeConflict,
  type DocumentRecords,
} from './canvasMerge'
import {
  CanvasRevisionConflictError,
  type CanvasSnapshot,
  type CanvasVersionedState,
  type Project,
} from './persistence'
import { pendingMaterializationStatus } from './canvasPendingMaterialization'
import {
  createCanvasRenameController,
  type CanvasRenameController,
} from './canvasRenameCoordinator'
import { changeSetTokenStamp, type ChangeSet } from '../model/changeset'

export {
  CanvasRenameAmbiguousError,
  CanvasRenameCommittedDrainError,
  CanvasRenameInProgressError,
  CanvasRenameRollbackDrainError,
} from './canvasRenameCoordinator'

export type CanvasWriteStatus =
  | 'loading' | 'idle' | 'unsaved' | 'saving' | 'syncing' | 'renaming'
  | 'rename-ambiguous' | 'conflict' | 'error'

export interface CanvasWriteCoordinatorTransport {
  load(projectId: string): Promise<CanvasVersionedState>
  save(projectId: string, snapshot: CanvasSnapshot, revision: number): Promise<number>
  renameProject(projectId: string, name: string): Promise<unknown>
  listProjects(): Promise<unknown>
}

export interface CanvasWriteCoordinatorEditor {
  setReadOnly(readOnly: boolean): void
  loadInitialSnapshot(snapshot: CanvasSnapshot): void
  applyAcceptedChangeSet(changeSet: ChangeSet, stamp: string): string[]
  captureSnapshot(): CanvasSnapshot
  captureDocument(): DocumentRecords
  normalizeDocument(snapshot: CanvasSnapshot): DocumentRecords
  applyDocument(document: DocumentRecords): string[]
  isEditing(): boolean
  onEditingEnd(listener: () => void): () => void
}

export interface CanvasWriteCoordinatorOptions {
  project: Project
  editor: CanvasWriteCoordinatorEditor
  transport: CanvasWriteCoordinatorTransport
  autosaveMs?: number
  onStatus?(status: CanvasWriteStatus): void
  onRemoteChange?(changedIds: string[], glow: boolean): void
}

export interface CanvasWriteCoordinator {
  initialize(): Promise<void>
  markDirty(): void
  requestRemoteSync(options?: { glow?: boolean }): Promise<void>
  flushOrThrow(): Promise<void>
  renameProject(name: string): Promise<Project>
  ownsProject(projectId: string): boolean
  dispose(): void
}

export class CanvasWriteMergeConflictError extends Error {
  constructor(readonly conflicts: CanvasMergeConflict[]) {
    super('canvas merge conflict')
    this.name = 'CanvasWriteMergeConflictError'
  }
}

export class CanvasWriteCoordinatorDisposedError extends Error {
  constructor() {
    super('canvas write coordinator disposed')
    this.name = 'CanvasWriteCoordinatorDisposedError'
  }
}

export class CanvasPendingMaterializationError extends Error {
  constructor() {
    super('pending change-set materialization is incomplete')
    this.name = 'CanvasPendingMaterializationError'
  }
}

interface Barrier {
  resolve(): void
  reject(error: unknown): void
}

const MAX_INITIALIZATION_CONFLICT_RETRIES = 1

export function createCanvasWriteCoordinator(
  options: CanvasWriteCoordinatorOptions,
): CanvasWriteCoordinator {
  const { editor, transport } = options
  const autosaveMs = options.autosaveMs ?? 500
  let project = options.project
  let projectId = project.id
  let lifecycle = 0
  let disposed = false
  let initialized = false
  let initializing: Promise<void> | null = null
  let applyingRemote = false
  let editingGeneration = 0
  let base: DocumentRecords | null = null
  let revision = 0
  let dirty = false
  let busy = false
  let syncRequested = false
  let syncGlow = false
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  let workSerial = 0
  const barriers: Barrier[] = []
  const editingEndBarriers: Barrier[] = []
  let renameController!: CanvasRenameController

  editor.setReadOnly(true)

  const isCurrent = (expected: number, expectedProjectId: string) =>
    !disposed && lifecycle === expected && projectId === expectedProjectId
  const assertCurrent = (expected: number, expectedProjectId: string) => {
    if (!isCurrent(expected, expectedProjectId)) throw new CanvasWriteCoordinatorDisposedError()
  }
  const publish = (status: CanvasWriteStatus) => {
    if (renameController?.suppressesStatus(status)) return
    if (!disposed) options.onStatus?.(status)
  }
  const clearAutosave = () => {
    if (autosaveTimer === null) return
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  const settleBarriers = (error?: unknown) => {
    for (const barrier of barriers.splice(0)) {
      if (error === undefined) barrier.resolve()
      else barrier.reject(error)
    }
  }

  const applyRemote = (document: DocumentRecords, glow: boolean) => {
    applyingRemote = true
    try {
      const changedIds = editor.applyDocument(document)
      if (changedIds.length > 0) options.onRemoteChange?.(changedIds, glow)
    } finally {
      applyingRemote = false
    }
  }

  const waitForEditingEnd = (): Promise<void> => {
    if (!editor.isEditing()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => editingEndBarriers.push({ resolve, reject }))
  }

  const loadConflictState = async (
    expected: number,
    expectedProjectId: string,
  ): Promise<CanvasVersionedState> => {
    for (;;) {
      if (editor.isEditing()) {
        await waitForEditingEnd()
        assertCurrent(expected, expectedProjectId)
      }
      const loadEditingGeneration = editingGeneration
      const loaded = await transport.load(expectedProjectId)
      assertCurrent(expected, expectedProjectId)
      if (!editor.isEditing() && editingGeneration === loadEditingGeneration) return loaded
    }
  }

  const saveAfterConflict = async (
    expected: number,
    expectedProjectId: string,
  ): Promise<void> => {
    const loaded = await loadConflictState(expected, expectedProjectId)
    const remote = editor.normalizeDocument(loaded.snapshot)
    const local = editor.captureDocument()
    if (!base) throw new Error('canvas write coordinator is not initialized')
    const merged = mergeCanvasRecords({ base, local, remote })
    if (!merged.ok) throw new CanvasWriteMergeConflictError(merged.conflicts)
    applyRemote(merged.document, false)
    base = remote
    revision = loaded.revision

    dirty = false
    const retryDocument = editor.captureDocument()
    const retrySnapshot = editor.captureSnapshot()
    try {
      const savedRevision = await transport.save(expectedProjectId, retrySnapshot, revision)
      assertCurrent(expected, expectedProjectId)
      base = retryDocument
      revision = savedRevision
    } catch (error) {
      dirty = true
      throw error
    }
  }

  const saveOnce = async (expected: number, expectedProjectId: string): Promise<void> => {
    const savedDocument = editor.captureDocument()
    const snapshot = editor.captureSnapshot()
    dirty = false
    publish('saving')
    try {
      const savedRevision = await transport.save(expectedProjectId, snapshot, revision)
      assertCurrent(expected, expectedProjectId)
      base = savedDocument
      revision = savedRevision
    } catch (error) {
      if (error instanceof CanvasRevisionConflictError) {
        try {
          await saveAfterConflict(expected, expectedProjectId)
          return
        } catch (conflictError) {
          dirty = true
          throw conflictError
        }
      }
      dirty = true
      throw error
    }
  }

  const syncOnce = async (expected: number, expectedProjectId: string): Promise<void> => {
    syncRequested = false
    const activeGlow = syncGlow
    syncGlow = false
    publish('syncing')
    try {
      const loadEditingGeneration = editingGeneration
      const loaded = await transport.load(expectedProjectId)
      assertCurrent(expected, expectedProjectId)
      if (editor.isEditing() || editingGeneration !== loadEditingGeneration) {
        syncRequested = true
        syncGlow = syncGlow || activeGlow
        return
      }
      const remote = editor.normalizeDocument(loaded.snapshot)
      const local = editor.captureDocument()
      if (!base) throw new Error('canvas write coordinator is not initialized')
      const merged = mergeCanvasRecords({ base, local, remote })
      if (!merged.ok) throw new CanvasWriteMergeConflictError(merged.conflicts)
      applyRemote(merged.document, activeGlow)
      base = remote
      revision = loaded.revision
    } catch (error) {
      if (isCurrent(expected, expectedProjectId)) {
        syncRequested = true
        syncGlow = syncGlow || activeGlow
      }
      throw error
    }
  }

  const start = () => {
    if (busy || disposed || !initialized || renameController?.blocksWork()) return
    busy = true
    const expected = lifecycle
    const expectedProjectId = projectId
    void (async () => {
      let failedAt: number | null = null
      let attemptedWorkSerial = workSerial
      try {
        while (dirty || syncRequested) {
          assertCurrent(expected, expectedProjectId)
          attemptedWorkSerial = workSerial
          if (dirty) {
            clearAutosave()
            await saveOnce(expected, expectedProjectId)
          } else if (editor.isEditing()) {
            break
          } else {
            await syncOnce(expected, expectedProjectId)
          }
        }
        assertCurrent(expected, expectedProjectId)
        if (!dirty && !syncRequested) {
          publish('idle')
          settleBarriers()
        }
      } catch (error) {
        failedAt = attemptedWorkSerial
        if (isCurrent(expected, expectedProjectId)) {
          publish(
            error instanceof CanvasRevisionConflictError ||
              error instanceof CanvasWriteMergeConflictError
              ? 'conflict'
              : 'error',
          )
          settleBarriers(error)
        }
      } finally {
        busy = false
        if (isCurrent(expected, expectedProjectId) && failedAt === null &&
          (dirty || syncRequested) &&
          !editor.isEditing()) start()
        if (isCurrent(expected, expectedProjectId) && failedAt !== null &&
          workSerial > failedAt) start()
      }
    })()
  }

  const signal = () => {
    start()
  }

  const initialize = (): Promise<void> => {
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    if (initialized) return Promise.resolve()
    if (initializing) return initializing
    const expected = lifecycle
    const expectedProjectId = projectId
    publish('loading')
    initializing = (async () => {
      try {
        let conflictRetries = 0
        for (;;) {
          assertCurrent(expected, expectedProjectId)
          const loaded = await transport.load(expectedProjectId)
          assertCurrent(expected, expectedProjectId)
          editor.loadInitialSnapshot(loaded.snapshot)
          assertCurrent(expected, expectedProjectId)

          if (loaded.pendingChangeSets.length === 0) {
            base = editor.captureDocument()
            revision = loaded.revision
            break
          }
          for (const entry of loaded.pendingChangeSets) {
            editor.applyAcceptedChangeSet(entry.changeSet, changeSetTokenStamp(entry.token))
          }
          const stagedDocument = editor.captureDocument()
          for (const entry of loaded.pendingChangeSets) {
            if (pendingMaterializationStatus(stagedDocument, entry) !== 'complete') {
              throw new CanvasPendingMaterializationError()
            }
          }
          try {
            revision = await transport.save(
              expectedProjectId,
              editor.captureSnapshot(),
              loaded.revision,
            )
            assertCurrent(expected, expectedProjectId)
            base = stagedDocument
            break
          } catch (error) {
            if (error instanceof CanvasRevisionConflictError &&
              conflictRetries < MAX_INITIALIZATION_CONFLICT_RETRIES) {
              conflictRetries += 1
              continue
            }
            throw error
          }
        }
        initialized = true
        editor.setReadOnly(false)
        publish('idle')
        if (syncRequested) start()
      } catch (error) {
        if (isCurrent(expected, expectedProjectId)) {
          initialized = false
          base = null
          revision = 0
          syncRequested = false
          syncGlow = false
          editor.setReadOnly(true)
          publish('error')
          settleBarriers(error)
        }
        throw error
      } finally {
        if (isCurrent(expected, expectedProjectId)) initializing = null
      }
    })()
    return initializing
  }

  const markDirty = () => {
    if (disposed || !initialized || applyingRemote) return
    dirty = true
    workSerial += 1
    publish('unsaved')
    clearAutosave()
    if (autosaveMs === 0) {
      signal()
    } else {
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null
        signal()
      }, autosaveMs)
    }
  }

  const requestRemoteSync = (request: { glow?: boolean } = {}): Promise<void> => {
    clearAutosave()
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    const renameError = renameController.ambiguousError()
    if (renameError) return Promise.reject(renameError)
    syncGlow = syncGlow || request.glow === true
    syncRequested = true
    workSerial += 1
    const promise = new Promise<void>((resolve, reject) => barriers.push({ resolve, reject }))
    if (initialized) signal()
    return promise
  }

  const flushCurrentOrThrow = (): Promise<void> => {
    clearAutosave()
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    if (!initialized) return Promise.reject(new Error('canvas write coordinator is not initialized'))
    if (!busy && !dirty && !syncRequested) return Promise.resolve()
    const promise = new Promise<void>((resolve, reject) => barriers.push({ resolve, reject }))
    signal()
    return promise
  }

  renameController = createCanvasRenameController({
    renameProject: (id, name) => transport.renameProject(id, name),
    listProjects: () => transport.listProjects(),
    getProject: () => project,
    getLifecycle: () => lifecycle,
    adoptProject: (next) => {
      project = next
      projectId = next.id
      lifecycle += 1
      return lifecycle
    },
    restoreProject: (restored) => {
      project = restored
      projectId = restored.id
    },
    assertCurrent,
    flushCurrentOrThrow,
    queuePostRebindSync: () => {
      syncRequested = true
      workSerial += 1
    },
    settleBarriers: (error) => settleBarriers(error),
    emitStatus: (status) => {
      if (!disposed) options.onStatus?.(status)
    },
    isDisposed: () => disposed,
    isDisposedError: (error) => error instanceof CanvasWriteCoordinatorDisposedError,
  })

  const flushOrThrow = (): Promise<void> => {
    const renameError = renameController.ambiguousError()
    if (renameError) return Promise.reject(renameError)
    const activeRename = renameController.activePromise()
    if (activeRename) return activeRename.then(() => undefined)
    return flushCurrentOrThrow()
  }

  const renameProject = (name: string): Promise<Project> =>
    renameController.renameProject(name)

  const ownsProject = (id: string): boolean => renameController.ownsProject(id)

  const dispose = () => {
    if (disposed) return
    disposed = true
    lifecycle += 1
    clearAutosave()
    unsubscribeEditingEnd()
    settleBarriers(new CanvasWriteCoordinatorDisposedError())
    settleEditingEndBarriers(new CanvasWriteCoordinatorDisposedError())
  }

  const settleEditingEndBarriers = (error?: unknown) => {
    for (const barrier of editingEndBarriers.splice(0)) {
      if (error === undefined) barrier.resolve()
      else barrier.reject(error)
    }
  }

  const unsubscribeEditingEnd = editor.onEditingEnd(() => {
    editingGeneration += 1
    settleEditingEndBarriers()
    if (!disposed && syncRequested) signal()
  })

  return {
    initialize,
    markDirty,
    requestRemoteSync,
    flushOrThrow,
    renameProject,
    ownsProject,
    dispose,
  }
}
