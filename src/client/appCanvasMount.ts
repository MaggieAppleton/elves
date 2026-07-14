import type { Editor } from 'tldraw'
import { CanvasRenameCommittedDrainError } from './canvasRenameCoordinator'
import type {
  CanvasWriteCoordinator,
  CanvasWriteStatus,
} from './canvasWriteCoordinator'
import type { Project } from './persistence'

export interface AppCanvasMount {
  project: Project
  readonly editor: Editor
  readonly writeCoordinator: CanvasWriteCoordinator
  readonly initialized: boolean
  initialize(): Promise<boolean>
  runCommand<T>(command: (context: AppCanvasCommandContext) => Promise<T>): Promise<T>
  waitForCommands(): Promise<void>
  closeCommands(): Promise<void>
  openCommands(): void
  restartSelection(start: () => () => void): void
  adoptProject(project: Project): void
  dispose(): void
}

export interface AppCanvasCommandContext {
  projectId: string
  assertCurrent(): void
}

export class AppCanvasMountStaleError extends Error {
  constructor() {
    super('canvas mount no longer owns this command')
    this.name = 'AppCanvasMountStaleError'
  }
}

export class AppCanvasCommandAdmissionClosedError extends Error {
  constructor() {
    super('canvas mount is not accepting commands')
    this.name = 'AppCanvasCommandAdmissionClosedError'
  }
}

interface AppCanvasMountOptions {
  project: Project
  editor: Editor
  writeCoordinator: CanvasWriteCoordinator
  listen(listener: () => void): () => void
}

export function createAppCanvasMount(options: AppCanvasMountOptions): AppCanvasMount {
  let initialized = false
  let initializing: Promise<boolean> | null = null
  let disposed = false
  let commandsOpen = true
  let stopDocumentListener: (() => void) | null = null
  let stopSelection: (() => void) | null = null
  const commands = new Set<Promise<unknown>>()

  const mount: AppCanvasMount = {
    project: options.project,
    editor: options.editor,
    writeCoordinator: options.writeCoordinator,
    get initialized() {
      return initialized
    },
    initialize() {
      if (initialized) return Promise.resolve(true)
      if (initializing) return initializing
      initializing = (async () => {
        await options.writeCoordinator.initialize()
        if (disposed) return false
        stopDocumentListener = options.listen(options.writeCoordinator.markDirty)
        initialized = true
        return true
      })().finally(() => {
        initializing = null
      })
      return initializing
    },
    runCommand(command) {
      if (!commandsOpen) return Promise.reject(new AppCanvasCommandAdmissionClosedError())
      const projectId = mount.project.id
      const assertCurrent = () => {
        if (disposed || !mount.writeCoordinator.ownsProject(projectId)) {
          throw new AppCanvasMountStaleError()
        }
      }
      const pending = Promise.resolve().then(() => {
        assertCurrent()
        return command({ projectId, assertCurrent })
      })
      commands.add(pending)
      const remove = () => commands.delete(pending)
      pending.then(remove, remove)
      return pending
    },
    async waitForCommands() {
      const results = await Promise.allSettled([...commands])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
    async closeCommands() {
      commandsOpen = false
      await mount.waitForCommands()
    },
    openCommands() {
      if (!disposed) commandsOpen = true
    },
    restartSelection(start) {
      stopSelection?.()
      stopSelection = start()
    },
    adoptProject(project) {
      mount.project = project
    },
    dispose() {
      if (disposed) return
      disposed = true
      commandsOpen = false
      stopDocumentListener?.()
      stopSelection?.()
      options.writeCoordinator.dispose()
    },
  }

  return mount
}

export async function flushCanvasMountForSwitch(mount: AppCanvasMount): Promise<void> {
  await mount.closeCommands()
  // tldraw batches store listeners to the next frame. Admit a same-tick edit
  // synchronously before asking the coordinator for the switch barrier.
  mount.writeCoordinator.markDirty()
  await mount.writeCoordinator.flushOrThrow()
}

export async function requestOwnedRemoteSync(
  mount: AppCanvasMount | null,
  projectId: string,
  glow: boolean,
): Promise<boolean> {
  if (!mount?.writeCoordinator.ownsProject(projectId)) return false
  await mount.writeCoordinator.requestRemoteSync({ glow })
  return true
}

export function committedRenameProject(error: unknown): Project | null {
  return error instanceof CanvasRenameCommittedDrainError ? error.project : null
}

export function canvasWriteStatusLabel(status: CanvasWriteStatus): string {
  switch (status) {
    case 'loading': return 'Loading canvas'
    case 'idle': return 'Canvas saved'
    case 'unsaved': return 'Canvas has unsaved changes'
    case 'saving': return 'Saving canvas'
    case 'syncing': return 'Syncing canvas'
    case 'renaming': return 'Renaming project'
    case 'rename-ambiguous': return 'Project rename needs attention'
    case 'conflict': return 'Canvas has a save conflict'
    case 'error': return 'Canvas save failed'
  }
}
