import {
  mergeCanvasRecords,
  type CanvasMergeConflict,
  type DocumentRecords,
} from './canvasMerge'
import {
  CanvasProtocolError,
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
import {
  createRecoveryEntry,
  recoveryKey,
  type CanvasRecoveryContext,
  type CanvasRecoveryEntry,
} from './canvasRecovery'

export {
  CanvasRenameAmbiguousError,
  CanvasRenameCommittedDrainError,
  CanvasRenameInProgressError,
  CanvasRenameRollbackDrainError,
} from './canvasRenameCoordinator'

export type CanvasWriteStatus =
  | 'loading' | 'idle' | 'unsaved' | 'saving' | 'syncing' | 'renaming'
  | 'retrying' | 'recovery-conflict' | 'recovery-unavailable'
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
  retryRandom?: () => number
  recovery?: CanvasRecoveryContext
  lifecycleTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  onStatus?(status: CanvasWriteStatus): void
  onRecoveryConflict?(active: boolean): void
  onRemoteChange?(changedIds: string[], glow: boolean): void
}

export interface CanvasWriteCoordinator {
  initialize(): Promise<void>
  markDirty(): void
  requestRemoteSync(options?: { glow?: boolean }): Promise<void>
  flushOrThrow(): Promise<void>
  retryNow(): Promise<void>
  whenRecoveryCommitted(): Promise<void>
  resolveRecovery(decision: 'recover' | 'discard'): Promise<void>
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

export class CanvasRecoveryDecisionRequiredError extends Error {
  constructor() {
    super('choose whether to recover or discard local canvas changes before continuing')
    this.name = 'CanvasRecoveryDecisionRequiredError'
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

interface PreRenameFlush {
  cutoff: number
  resolve(): void
  reject(error: unknown): void
}

interface PendingRecoveryConflict {
  entry: CanvasRecoveryEntry
  remote: DocumentRecords
}

interface AmbiguousSave {
  base: DocumentRecords
  attempted: DocumentRecords
  generation: number
}

const MAX_INITIALIZATION_CONFLICT_RETRIES = 1
const TRANSIENT_RETRY_CAPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const

export function createCanvasWriteCoordinator(
  options: CanvasWriteCoordinatorOptions,
): CanvasWriteCoordinator {
  const { editor, transport } = options
  const autosaveMs = options.autosaveMs ?? 500
  const retryRandom = options.retryRandom ?? Math.random
  const recovery = options.project.storageId ? options.recovery : undefined
  const lifecycleTarget = options.lifecycleTarget ??
    (typeof window === 'undefined' ? undefined : window)
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
  let baseEpoch = ''
  let dirty = false
  let busy = false
  let syncRequested = false
  let syncGlow = false
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0
  let ambiguousSave: AmbiguousSave | null = null
  let workSerial = 0
  const barriers: Barrier[] = []
  const editingEndBarriers: Barrier[] = []
  let preRenameFlush: PreRenameFlush | null = null
  let journalGeneration = 0
  let latestJournalCommit: Promise<void> = Promise.resolve()
  let journalQueue: Promise<void> = Promise.resolve()
  let journalUnavailable = false
  let journalCreatedAt: string | null = null
  let pendingRecovery: PendingRecoveryConflict | null = null
  const recoveredSourceGenerations = new Map<string, number>()
  let unloadGuardInstalled = false
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
  const clearRetryTimer = () => {
    if (retryTimer === null) return
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const resetRetryPolicy = () => {
    clearRetryTimer()
    retryAttempt = 0
  }
  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    event.returnValue = ''
  }
  const installUnloadGuard = () => {
    if (unloadGuardInstalled || !lifecycleTarget) return
    lifecycleTarget.addEventListener('beforeunload', beforeUnload)
    unloadGuardInstalled = true
  }
  const removeUnloadGuard = () => {
    if (!unloadGuardInstalled || !lifecycleTarget) return
    lifecycleTarget.removeEventListener('beforeunload', beforeUnload)
    unloadGuardInstalled = false
  }
  const settleBarriers = (error?: unknown) => {
    for (const barrier of barriers.splice(0)) {
      if (error === undefined) barrier.resolve()
      else barrier.reject(error)
    }
  }
  const settlePreRenameFlush = (error?: unknown) => {
    const active = preRenameFlush
    if (!active) return
    preRenameFlush = null
    // Public barriers stay pending until their queued work drains under the resolved identity.
    if (error === undefined) active.resolve()
    else active.reject(error)
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

  const queueJournal = (): Promise<void> => {
    if (!recovery || !base) return Promise.resolve()
    const generation = journalGeneration
    const now = (recovery.now ?? (() => new Date().toISOString()))()
    journalCreatedAt ??= now
    const entry = createRecoveryEntry({
      serverOrigin: recovery.serverOrigin,
      storageId: project.storageId!,
      projectId,
      sessionId: recovery.sessionId,
      generation,
      createdAt: journalCreatedAt,
      updatedAt: now,
      baseRevision: revision,
      baseEpoch,
      baseDocument: structuredClone(base),
      localDocument: structuredClone(editor.captureDocument()),
      localSnapshot: structuredClone(editor.captureSnapshot()),
    })
    installUnloadGuard()
    const commit = journalQueue.catch(() => undefined).then(() => recovery.store.put(entry))
      .then(() => {
        if (generation === journalGeneration) journalUnavailable = false
      })
      .catch((error) => {
        journalUnavailable = true
        publish('recovery-unavailable')
        throw error
      })
    journalQueue = commit.catch(() => undefined)
    latestJournalCommit = commit
    return commit
  }

  const clearAcknowledgedRecovery = async (generation: number): Promise<void> => {
    if (!recovery) return
    try {
      const currentKey = recoveryKey(recovery.serverOrigin, project.storageId!, recovery.sessionId)
      await recovery.store.deleteIfGeneration(currentKey, generation)
      for (const [key, sourceGeneration] of recoveredSourceGenerations) {
        await recovery.store.deleteIfGeneration(key, sourceGeneration)
      }
      recoveredSourceGenerations.clear()
      journalUnavailable = false
      if (generation === journalGeneration && !dirty) {
        journalCreatedAt = null
        removeUnloadGuard()
      }
    } catch {
      journalUnavailable = true
      publish('recovery-unavailable')
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
    baseEpoch = loaded.nextChangeSetToken.epoch

    dirty = false
    const retryDocument = editor.captureDocument()
    const retrySnapshot = editor.captureSnapshot()
    const savedGeneration = journalGeneration
    await queueJournal().catch(() => undefined)
    await latestJournalCommit.catch(() => undefined)
    try {
      const savedRevision = await transport.save(expectedProjectId, retrySnapshot, revision)
      assertCurrent(expected, expectedProjectId)
      base = retryDocument
      revision = savedRevision
      ambiguousSave = null
      resetRetryPolicy()
      await clearAcknowledgedRecovery(savedGeneration)
      if (dirty && journalGeneration > savedGeneration) await queueJournal().catch(() => undefined)
    } catch (error) {
      dirty = true
      if (isAmbiguousTransportFailure(error)) {
        ambiguousSave = { base: structuredClone(base), attempted: retryDocument, generation: savedGeneration }
      }
      throw error
    }
  }

  const reconcileAmbiguousSave = async (
    expected: number,
    expectedProjectId: string,
  ): Promise<void> => {
    const pending = ambiguousSave
    if (!pending) return
    publish('syncing')
    const loaded = await loadConflictState(expected, expectedProjectId)
    const remote = editor.normalizeDocument(loaded.snapshot)
    const local = editor.captureDocument()
    if (recordsEqual(remote, pending.attempted)) {
      base = remote
      revision = loaded.revision
      baseEpoch = loaded.nextChangeSetToken.epoch
      ambiguousSave = null
      dirty = !recordsEqual(local, remote)
      await clearAcknowledgedRecovery(pending.generation)
      if (dirty) await queueJournal().catch(() => undefined)
      return
    }
    const merged = mergeCanvasRecords({ base: pending.base, local, remote })
    if (!merged.ok) throw new CanvasWriteMergeConflictError(merged.conflicts)
    applyRemote(merged.document, false)
    base = remote
    revision = loaded.revision
    baseEpoch = loaded.nextChangeSetToken.epoch
    ambiguousSave = null
    dirty = !recordsEqual(merged.document, remote)
    if (dirty) await queueJournal().catch(() => undefined)
    else await clearAcknowledgedRecovery(pending.generation)
  }

  const saveOnce = async (expected: number, expectedProjectId: string): Promise<void> => {
    await reconcileAmbiguousSave(expected, expectedProjectId)
    if (!dirty) {
      resetRetryPolicy()
      return
    }
    await latestJournalCommit.catch(() => undefined)
    const savedDocument = editor.captureDocument()
    const snapshot = editor.captureSnapshot()
    const savedGeneration = journalGeneration
    const savedBase = base
    dirty = false
    publish('saving')
    try {
      const savedRevision = await transport.save(expectedProjectId, snapshot, revision)
      assertCurrent(expected, expectedProjectId)
      base = savedDocument
      revision = savedRevision
      ambiguousSave = null
      resetRetryPolicy()
      await clearAcknowledgedRecovery(savedGeneration)
      if (dirty && journalGeneration > savedGeneration) await queueJournal().catch(() => undefined)
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
      if (isAmbiguousTransportFailure(error) && savedBase) {
        ambiguousSave = { base: structuredClone(savedBase), attempted: savedDocument, generation: savedGeneration }
      }
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
      baseEpoch = loaded.nextChangeSetToken.epoch
    } catch (error) {
      if (isCurrent(expected, expectedProjectId)) {
        syncRequested = true
        syncGlow = syncGlow || activeGlow
      }
      throw error
    }
  }

  const scheduleTransientRetry = (): boolean => {
    if (retryTimer !== null || retryAttempt >= TRANSIENT_RETRY_CAPS_MS.length) return false
    const cap = TRANSIENT_RETRY_CAPS_MS[retryAttempt]
    retryAttempt += 1
    const jitter = Math.min(1, Math.max(0, retryRandom()))
    const delayMs = Math.floor(cap * jitter)
    publish('retrying')
    retryTimer = setTimeout(() => {
      retryTimer = null
      start()
    }, delayMs)
    return true
  }

  const start = (ignoreRenameGate = false) => {
    if (busy || disposed || !initialized || pendingRecovery ||
      (!ignoreRenameGate && renameController?.blocksWork())) return
    clearRetryTimer()
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
          // Finish the operation admitted before the gate, then leave later signals queued.
          if (preRenameFlush && attemptedWorkSerial <= preRenameFlush.cutoff) {
            settlePreRenameFlush()
            break
          }
        }
        assertCurrent(expected, expectedProjectId)
        if (preRenameFlush && !dirty && (!syncRequested || editor.isEditing())) {
          settlePreRenameFlush()
        }
        if (!dirty && !syncRequested) {
          publish(journalUnavailable ? 'recovery-unavailable' : 'idle')
          settleBarriers()
        }
      } catch (error) {
        failedAt = attemptedWorkSerial
        if (isCurrent(expected, expectedProjectId)) {
          const conflict = error instanceof CanvasRevisionConflictError ||
            error instanceof CanvasWriteMergeConflictError
          const retryScheduled = !conflict && isTransientFailure(error) && scheduleTransientRetry()
          if (conflict) publish('conflict')
          else if (!retryScheduled) publish(journalUnavailable ? 'recovery-unavailable' : 'error')
          settlePreRenameFlush(error)
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
        await recovery?.ready
        assertCurrent(expected, expectedProjectId)
        let conflictRetries = 0
        let authoritativeState: CanvasVersionedState | null = null
        for (;;) {
          assertCurrent(expected, expectedProjectId)
          const loaded = await transport.load(expectedProjectId)
          assertCurrent(expected, expectedProjectId)
          editor.loadInitialSnapshot(loaded.snapshot)
          assertCurrent(expected, expectedProjectId)

          if (loaded.pendingChangeSets.length === 0) {
            const initialDocument = editor.captureDocument()
            if (loaded.snapshot.document === null) {
              try {
                revision = await transport.save(
                  expectedProjectId,
                  editor.captureSnapshot(),
                  loaded.revision,
                )
                assertCurrent(expected, expectedProjectId)
              } catch (error) {
                if (error instanceof CanvasRevisionConflictError &&
                  conflictRetries < MAX_INITIALIZATION_CONFLICT_RETRIES) {
                  conflictRetries += 1
                  continue
                }
                throw error
              }
            } else {
              revision = loaded.revision
            }
            base = initialDocument
            baseEpoch = loaded.nextChangeSetToken.epoch
            authoritativeState = { ...loaded, revision, snapshot: editor.captureSnapshot(), pendingChangeSets: [] }
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
            baseEpoch = loaded.nextChangeSetToken.epoch
            authoritativeState = { ...loaded, revision, snapshot: editor.captureSnapshot(), pendingChangeSets: [] }
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
        if (authoritativeState) await restoreRecovery(authoritativeState)
        if (pendingRecovery) {
          editor.setReadOnly(true)
          publish('recovery-conflict')
          options.onRecoveryConflict?.(true)
        } else {
          editor.setReadOnly(false)
          publish(dirty ? 'unsaved' : journalUnavailable ? 'recovery-unavailable' : 'idle')
          if (dirty || syncRequested) start()
        }
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
    if (disposed || !initialized || applyingRemote || pendingRecovery) return
    dirty = true
    workSerial += 1
    journalGeneration += 1
    publish('unsaved')
    void queueJournal().catch(() => undefined)
    clearRetryTimer()
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
    if (initialized && !pendingRecovery) signal()
    return promise
  }

  const flushCurrentOrThrow = (): Promise<void> => {
    clearAutosave()
    clearRetryTimer()
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    if (!initialized) return Promise.reject(new Error('canvas write coordinator is not initialized'))
    if (pendingRecovery) return Promise.reject(new CanvasRecoveryDecisionRequiredError())
    if (!busy && !dirty && !syncRequested) return Promise.resolve()
    const promise = new Promise<void>((resolve, reject) => barriers.push({ resolve, reject }))
    signal()
    return promise
  }

  const beginPreRenameFlush = (): Promise<void> => {
    clearAutosave()
    clearRetryTimer()
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    if (!initialized) return Promise.reject(new Error('canvas write coordinator is not initialized'))
    if (pendingRecovery) return Promise.reject(new CanvasRecoveryDecisionRequiredError())
    if (!busy && !dirty && !syncRequested) return Promise.resolve()
    const cutoff = workSerial
    const promise = new Promise<void>((resolve, reject) => {
      preRenameFlush = { cutoff, resolve, reject }
    })
    start(true)
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
    beginPreRenameFlush,
    flushCurrentOrThrow,
    queuePostRebindSync: () => {
      syncRequested = true
      workSerial += 1
    },
    settleBarriers: (error) => settleBarriers(error),
    emitStatus: (status) => {
      if (!disposed) options.onStatus?.(status)
    },
    setReadOnly: (readOnly) => {
      if (!disposed) editor.setReadOnly(readOnly)
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

  const retryNow = (): Promise<void> => {
    clearAutosave()
    clearRetryTimer()
    if (disposed) return Promise.reject(new CanvasWriteCoordinatorDisposedError())
    if (!initialized) return Promise.reject(new Error('canvas write coordinator is not initialized'))
    if (pendingRecovery) return Promise.reject(new CanvasRecoveryDecisionRequiredError())
    const promise = new Promise<void>((resolve, reject) => barriers.push({ resolve, reject }))
    workSerial += 1
    start()
    return promise
  }

  const whenRecoveryCommitted = (): Promise<void> => latestJournalCommit

  const resolveRecovery = async (decision: 'recover' | 'discard'): Promise<void> => {
    const conflict = pendingRecovery
    if (!conflict || disposed) return
    if (decision === 'discard') {
      await recovery?.store.delete(conflict.entry.key)
      pendingRecovery = null
      options.onRecoveryConflict?.(false)
      editor.setReadOnly(false)
      publish('idle')
      if (syncRequested) start()
      return
    }
    const preferred = preferLocalChanges(conflict.entry.baseDocument, conflict.entry.localDocument, conflict.remote)
    applyRemote(preferred, false)
    recoveredSourceGenerations.set(conflict.entry.key, conflict.entry.generation)
    pendingRecovery = null
    options.onRecoveryConflict?.(false)
    editor.setReadOnly(false)
    dirty = true
    workSerial += 1
    journalGeneration = Math.max(journalGeneration, conflict.entry.generation)
    journalGeneration += 1
    publish('unsaved')
    await queueJournal().catch(() => undefined)
    start()
  }

  const renameProject = (name: string): Promise<Project> =>
    renameController.renameProject(name)

  const ownsProject = (id: string): boolean => renameController.ownsProject(id)

  const dispose = () => {
    if (disposed) return
    disposed = true
    lifecycle += 1
    clearAutosave()
    clearRetryTimer()
    removeUnloadGuard()
    unsubscribeEditingEnd()
    settlePreRenameFlush(new CanvasWriteCoordinatorDisposedError())
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
    retryNow,
    whenRecoveryCommitted,
    resolveRecovery,
    renameProject,
    ownsProject,
    dispose,
  }

  async function restoreRecovery(authoritative: CanvasVersionedState): Promise<void> {
    if (!recovery || !base) return
    let entries: CanvasRecoveryEntry[]
    try {
      entries = await recovery.store.list(recovery.serverOrigin, project.storageId!)
    } catch {
      journalUnavailable = true
      return
    }
    const activeSessionIds = await recovery.activeSessionIds?.()
    entries = entries
      .filter((candidate) => candidate.sessionId === recovery.sessionId ||
        (activeSessionIds ? !activeSessionIds.has(candidate.sessionId) : false))
      .sort((left, right) => Number(right.sessionId === recovery.sessionId) -
        Number(left.sessionId === recovery.sessionId) || right.updatedAt.localeCompare(left.updatedAt))
    let entry: CanvasRecoveryEntry | undefined
    const remote = editor.captureDocument()
    for (const candidate of entries) {
      if (recordsEqual(candidate.localDocument, remote)) {
        await recovery.store.delete(candidate.key).catch(() => { journalUnavailable = true })
      } else {
        entry = candidate
        break
      }
    }
    if (!entry) return
    if (entry.baseEpoch !== authoritative.nextChangeSetToken.epoch) {
      pendingRecovery = { entry, remote }
      return
    }
    const merged = mergeCanvasRecords({ base: entry.baseDocument, local: entry.localDocument, remote })
    if (!merged.ok) {
      pendingRecovery = { entry, remote }
      return
    }
    applyRemote(merged.document, false)
    journalGeneration = Math.max(journalGeneration, entry.generation)
    recoveredSourceGenerations.set(entry.key, entry.generation)
    dirty = !recordsEqual(merged.document, remote)
    installUnloadGuard()
  }
}

function recordsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => recordsEqual(value, right[index]))
  }
  if (typeof left !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && recordsEqual(leftRecord[key], rightRecord[key]))
}

function preferLocalChanges(
  base: DocumentRecords,
  local: DocumentRecords,
  remote: DocumentRecords,
): DocumentRecords {
  const merged = structuredClone(remote)
  for (const id of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (recordsEqual(base[id], local[id])) continue
    if (local[id] === undefined) delete merged[id]
    else merged[id] = structuredClone(local[id])
  }
  return merged
}

function isTransientFailure(error: unknown): boolean {
  if (isAmbiguousTransportFailure(error)) return true
  return error instanceof CanvasProtocolError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
}

function isAmbiguousTransportFailure(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}
