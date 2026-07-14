import {
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from 'tldraw'
import { applyChangeSet } from '../apply/applyChangeSet'
import type { ChangeSet } from '../model/changeset'
import {
  applyCanvasDocument,
  captureCanvasDocument,
  normalizeCanvasDocument,
  type CanvasDocumentSnapshot,
} from './canvasDocumentAdapter'
import type { DocumentRecords } from './canvasMerge'
import type { CanvasSnapshot } from './persistence'
import type { CanvasWriteCoordinatorEditor } from './canvasWriteCoordinator'

/** Bind the coordinator's persistence contract to one mounted tldraw editor. */
export function createTldrawCanvasWriteCoordinatorEditor(
  editor: Editor,
): CanvasWriteCoordinatorEditor {
  return {
    setReadOnly(readOnly) {
      editor.updateInstanceState({ isReadonly: readOnly })
    },

    loadInitialSnapshot(snapshot) {
      loadSnapshot(
        editor.store,
        snapshot as unknown as Partial<TLEditorSnapshot> | TLStoreSnapshot,
        { forceOverwriteSessionState: true },
      )
    },

    applyAcceptedChangeSet(changeSet: ChangeSet, stamp: string): string[] {
      let changedIds: string[] = []
      editor.run(() => {
        changedIds = applyChangeSet(editor, changeSet, stamp)
      }, { history: 'ignore' })
      return changedIds
    },

    captureSnapshot(): CanvasSnapshot {
      return structuredClone(getSnapshot(editor.store)) as unknown as CanvasSnapshot
    },

    captureDocument(): DocumentRecords {
      return captureCanvasDocument(editor.store)
    },

    normalizeDocument(snapshot: CanvasSnapshot): DocumentRecords {
      return normalizeCanvasDocument(editor.store, snapshot as CanvasDocumentSnapshot)
    },

    applyDocument(document: DocumentRecords): string[] {
      let changedIds: string[] = []
      editor.run(() => {
        changedIds = applyCanvasDocument(editor.store, document)
      }, { history: 'ignore' })
      return changedIds
    },

    isEditing(): boolean {
      return editor.getEditingShapeId() !== null
    },

    onEditingEnd(listener: () => void): () => void {
      let wasEditing = editor.getEditingShapeId() !== null
      return editor.store.listen(() => {
        const editing = editor.getEditingShapeId() !== null
        const ended = wasEditing && !editing
        wasEditing = editing
        if (ended) listener()
      }, { scope: 'session' })
    },
  }
}
