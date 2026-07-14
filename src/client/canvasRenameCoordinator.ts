import type { Project } from './persistence'
import {
  classifyCanvasRenameOutcome,
  validRenameResult,
  type CanvasRenameAmbiguousReason,
  type CanvasRenameOutcome,
} from './canvasRenameResolution'

export class CanvasRenameAmbiguousError extends Error {
  constructor(
    readonly reason: CanvasRenameAmbiguousReason | 'list-failed',
    options: { cause?: unknown } = {},
  ) {
    super('project rename outcome is ambiguous', options)
    this.name = 'CanvasRenameAmbiguousError'
  }
}

export class CanvasRenameInProgressError extends Error {
  constructor() {
    super('project rename already in progress')
    this.name = 'CanvasRenameInProgressError'
  }
}

export class CanvasRenameCommittedDrainError extends Error {
  constructor(readonly project: Project, cause: unknown) {
    super('project rename committed but queued canvas work failed', { cause })
    this.name = 'CanvasRenameCommittedDrainError'
  }
}

export class CanvasRenameRollbackDrainError extends Error {
  constructor(
    readonly project: Project,
    readonly renameError: unknown,
    readonly saveError: unknown,
  ) {
    super('project rename rolled back but queued canvas work failed', { cause: saveError })
    this.name = 'CanvasRenameRollbackDrainError'
  }
}

interface RenameJob {
  requestedName: string
  promise: Promise<Project>
}

interface RenameAmbiguousState {
  requestedName: string
  original: Project
  originalError: unknown
  error: CanvasRenameAmbiguousError
}

export interface CanvasRenameController {
  renameProject(name: string): Promise<Project>
  ownsProject(projectId: string): boolean
  blocksWork(): boolean
  suppressesStatus(status: string): boolean
  ambiguousError(): CanvasRenameAmbiguousError | null
  activePromise(): Promise<Project> | null
}

export interface CanvasRenameControllerOptions {
  renameProject(projectId: string, name: string): Promise<unknown>
  listProjects(): Promise<unknown>
  getProject(): Project
  getLifecycle(): number
  adoptProject(project: Project): number
  restoreProject(project: Project): void
  assertCurrent(lifecycle: number, projectId: string): void
  beginPreRenameFlush(): Promise<void>
  flushCurrentOrThrow(): Promise<void>
  queuePostRebindSync(): void
  settleBarriers(error: unknown): void
  emitStatus(status: 'renaming' | 'rename-ambiguous' | 'idle' | 'error'): void
  setReadOnly(readOnly: boolean): void
  isDisposed(): boolean
  isDisposedError(error: unknown): boolean
}

export function createCanvasRenameController(
  options: CanvasRenameControllerOptions,
): CanvasRenameController {
  let renameJob: RenameJob | null = null
  let exclusive = false
  let ambiguous: RenameAmbiguousState | null = null

  const enterAmbiguous = (
    requestedName: string,
    original: Project,
    originalError: unknown,
    reason: CanvasRenameAmbiguousReason | 'list-failed',
    cause?: unknown,
  ): never => {
    const error = new CanvasRenameAmbiguousError(reason, { cause })
    ambiguous = { requestedName, original, originalError, error }
    exclusive = true
    options.setReadOnly(true)
    options.settleBarriers(error)
    options.emitStatus('rename-ambiguous')
    throw error
  }

  const observe = async (
    original: Project,
    requestedName: string,
    originalError: unknown,
    expected: number,
  ): Promise<CanvasRenameOutcome> => {
    let projects: unknown
    try {
      projects = await options.listProjects()
    } catch (error) {
      options.assertCurrent(expected, original.id)
      return enterAmbiguous(
        requestedName, original, originalError, 'list-failed', error,
      )
    }
    options.assertCurrent(expected, original.id)
    return classifyCanvasRenameOutcome(projects, original, requestedName)
  }

  const adoptAndDrain = async (next: Project): Promise<Project> => {
    const reboundLifecycle = options.adoptProject(next)
    ambiguous = null
    exclusive = false
    options.queuePostRebindSync()
    try {
      await options.flushCurrentOrThrow()
    } catch (error) {
      if (options.isDisposedError(error)) throw error
      throw new CanvasRenameCommittedDrainError(next, error)
    } finally {
      if (!options.isDisposed()) options.setReadOnly(false)
    }
    options.assertCurrent(reboundLifecycle, next.id)
    return next
  }

  const resolveOutcome = async (
    outcome: CanvasRenameOutcome,
    original: Project,
    requestedName: string,
    originalError: unknown,
    expected: number,
    allowRepair: boolean,
  ): Promise<Project> => {
    if (outcome.kind === 'committed') return adoptAndDrain(outcome.project)
    if (outcome.kind === 'rolled-back') {
      options.restoreProject(outcome.project)
      ambiguous = null
      exclusive = false
      try {
        await options.flushCurrentOrThrow()
      } catch (error) {
        if (options.isDisposedError(error)) throw error
        throw new CanvasRenameRollbackDrainError(outcome.project, originalError, error)
      } finally {
        if (!options.isDisposed()) options.setReadOnly(false)
      }
      options.assertCurrent(expected, outcome.project.id)
      throw originalError
    }
    if (outcome.kind === 'partial-move' && allowRepair) {
      try {
        await options.renameProject(outcome.project.id, requestedName)
      } catch {
        // A repair response can be lost too; the bounded follow-up list decides.
      }
      options.assertCurrent(expected, original.id)
      const repaired = await observe(original, requestedName, originalError, expected)
      return resolveOutcome(
        repaired, original, requestedName, originalError, expected, false,
      )
    }
    const reason = outcome.kind === 'ambiguous' ? outcome.reason : 'unknown-state'
    return enterAmbiguous(requestedName, original, originalError, reason)
  }

  const renameProject = (requestedName: string): Promise<Project> => {
    const name = requestedName.trim()
    if (!name) return Promise.reject(new Error('project name required'))
    if (renameJob) {
      return renameJob.requestedName === name
        ? renameJob.promise
        : Promise.reject(ambiguous?.error ?? new CanvasRenameInProgressError())
    }
    if (ambiguous && ambiguous.requestedName !== name) {
      return Promise.reject(ambiguous.error)
    }
    const retry = ambiguous
    const original = retry?.original ?? options.getProject()
    const expected = options.getLifecycle()
    let succeeded = false
    const operation = (async (): Promise<Project> => {
      if (retry) {
        const observed = await observe(original, name, retry.originalError, expected)
        const result = await resolveOutcome(
          observed, original, name, retry.originalError, expected, true,
        )
        succeeded = true
        return result
      }
      options.emitStatus('renaming')
      exclusive = true
      options.setReadOnly(true)
      const preRenameFlush = options.beginPreRenameFlush()
      await preRenameFlush
      options.assertCurrent(expected, original.id)
      let response: unknown
      let renameError: unknown = new Error('invalid project rename response')
      try {
        response = await options.renameProject(original.id, name)
      } catch (error) {
        renameError = error
      }
      options.assertCurrent(expected, original.id)
      const renamed = validRenameResult(response, original, name)
      const result = renamed
        ? await adoptAndDrain(renamed)
        : await resolveOutcome(
            await observe(original, name, renameError, expected),
            original,
            name,
            renameError,
            expected,
            true,
          )
      succeeded = true
      return result
    })()
    const promise = operation.finally(() => {
      if (renameJob?.promise === promise) renameJob = null
      if (!ambiguous) exclusive = false
      if (!options.isDisposed()) {
        if (!ambiguous) options.setReadOnly(false)
        if (succeeded) options.emitStatus('idle')
        else if (!ambiguous) options.emitStatus('error')
      }
    })
    renameJob = { requestedName: name, promise }
    return promise
  }

  return {
    renameProject,
    ownsProject: (id) =>
      !options.isDisposed() && ambiguous === null && options.getProject().id === id,
    blocksWork: () => exclusive,
    suppressesStatus: (status) =>
      (ambiguous !== null && status !== 'rename-ambiguous') ||
      (renameJob !== null && status !== 'renaming'),
    ambiguousError: () => ambiguous?.error ?? null,
    activePromise: () => renameJob?.promise ?? null,
  }
}
