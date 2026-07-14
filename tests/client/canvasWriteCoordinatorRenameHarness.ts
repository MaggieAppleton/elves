import { vi } from 'vitest'
import type { DocumentRecords } from '../../src/client/canvasMerge'
import type { CanvasSnapshot, Project } from '../../src/client/persistence'
import {
  createCanvasWriteCoordinator,
  type CanvasWriteCoordinatorEditor,
  type CanvasWriteCoordinatorTransport,
  type CanvasWriteStatus,
} from '../../src/client/canvasWriteCoordinator'
import { document, state } from './canvasWriteCoordinatorInitializationHarness'

export const originalProject: Project = {
  id: 'draft',
  name: 'Draft',
  createdAt: '2026-07-14T00:00:00.000Z',
}

export function renameHarness(options: {
  load?: CanvasWriteCoordinatorTransport['load']
  save?: CanvasWriteCoordinatorTransport['save']
  renameProject?: (projectId: string, name: string) => Promise<unknown>
  listProjects?: () => Promise<unknown>
} = {}) {
  let current = document('remote')
  let editing = false
  let editingEnd: (() => void) | null = null
  const statuses: CanvasWriteStatus[] = []
  const load = vi.fn(options.load ?? (async (_projectId: string) => state(document('remote'), 7)))
  const save = vi.fn(options.save ?? (async (_id, _snapshot, revision) => revision + 1))
  const renameProject = vi.fn(options.renameProject ?? (async (_id, name) => ({
    ...originalProject, id: 'final', name,
  })))
  const listProjects = vi.fn(options.listProjects ?? (async () => [originalProject]))
  const readOnly = vi.fn()
  const editor: CanvasWriteCoordinatorEditor = {
    setReadOnly: readOnly,
    loadInitialSnapshot: (snapshot) => {
      if (snapshot.document !== null) current = structuredClone(snapshot.document as DocumentRecords)
    },
    applyAcceptedChangeSet: () => [],
    captureSnapshot: (): CanvasSnapshot => ({ document: structuredClone(current) }),
    captureDocument: () => structuredClone(current),
    normalizeDocument: (snapshot) => structuredClone(snapshot.document as DocumentRecords),
    applyDocument: (next) => {
      current = structuredClone(next)
      return []
    },
    isEditing: () => editing,
    onEditingEnd: (listener) => {
      editingEnd = listener
      return () => { editingEnd = null }
    },
  }
  const coordinator = createCanvasWriteCoordinator({
    project: originalProject,
    editor,
    transport: { load, save, renameProject, listProjects },
    autosaveMs: 0,
    onStatus: (status) => statuses.push(status),
  })
  return {
    coordinator,
    load,
    save,
    renameProject,
    listProjects,
    statuses,
    readOnly,
    get document() { return current },
    setDocument(next: DocumentRecords) { current = structuredClone(next) },
    setEditing(next: boolean) {
      const wasEditing = editing
      editing = next
      if (wasEditing && !next) editingEnd?.()
    },
  }
}
