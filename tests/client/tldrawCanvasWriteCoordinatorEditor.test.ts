import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createTLStore,
  defaultShapeUtils,
  getSnapshot,
  TLDOCUMENT_ID,
  type Editor,
  type TLCameraId,
  type TLPageId,
  type TLStore,
  type TLStoreSnapshot,
} from 'tldraw'
import { CHANGE_SET_STAMP_META_KEY, type ChangeSet } from '../../src/model/changeset'
import { createTldrawCanvasWriteCoordinatorEditor } from '../../src/client/tldrawCanvasWriteCoordinatorEditor'

const stores: TLStore[] = []
const PAGE_ID = 'page:page' as TLPageId

function makeStore(): TLStore {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  ;(store as TLStore & { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
  stores.push(store)
  return store
}

function recordByType(store: TLStore, typeName: string): any {
  const record = store.allRecords().find((candidate) => candidate.typeName === typeName)
  if (!record) throw new Error(`missing ${typeName} record`)
  return record
}

function makeEditor(store = makeStore()) {
  const runOptions: unknown[] = []
  const editor = {
    store,
    runOptions,
    updateInstanceState(partial: Record<string, unknown>) {
      const instance = recordByType(store, 'instance')
      store.put([{ ...instance, ...partial }])
      return editor
    },
    getEditingShapeId() {
      return recordByType(store, 'instance_page_state').editingShapeId
    },
    run(fn: () => void, options?: unknown) {
      runOptions.push(options)
      fn()
      return editor
    },
  }
  return editor as unknown as Editor & { runOptions: unknown[] }
}

function setEditingShapeId(store: TLStore, editingShapeId: string | null): void {
  const pageState = recordByType(store, 'instance_page_state')
  store.put([{ ...pageState, editingShapeId }])
}

function updateCamera(store: TLStore, x: number): void {
  store.update('camera:page:page' as TLCameraId, (camera) => ({ ...camera, x }))
}

function makeChangeSetEditor() {
  const editor = makeEditor()
  const shapes = new Map<string, Record<string, any>>()
  Object.assign(editor, {
    shapes,
    markHistoryStoppingPoint: () => 'accepted-change-set',
    squashToMark: () => {},
    getShape: (id: string) => shapes.get(id),
    getCurrentPageShapes: () => [...shapes.values()],
    getShapePageBounds: (id: string) => {
      const shape = shapes.get(id)
      return shape
        ? { x: shape.x ?? 0, y: shape.y ?? 0, w: shape.props?.w ?? 100, h: shape.props?.h ?? 50 }
        : undefined
    },
    createShape: (shape: Record<string, any>) => { shapes.set(shape.id, { ...shape }) },
  })
  return editor as typeof editor & { shapes: Map<string, Record<string, any>> }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
})

describe('tldraw canvas write coordinator editor', () => {
  test('sets readonly mode on the live editor instance', () => {
    const editor = makeEditor()
    const adapter = createTldrawCanvasWriteCoordinatorEditor(editor)

    adapter.setReadOnly(true)
    expect(recordByType(editor.store, 'instance').isReadonly).toBe(true)
    adapter.setReadOnly(false)
    expect(recordByType(editor.store, 'instance').isReadonly).toBe(false)
  })

  test('loads and migrates the full initial document and session', () => {
    const source = makeStore()
    updateCamera(source, 73)
    const sourceInstance = recordByType(source, 'instance')
    source.put([{ ...sourceInstance, isGridMode: true }])
    const incoming = structuredClone(getSnapshot(source)) as unknown as {
      document: TLStoreSnapshot & {
        store: Record<string, Record<string, unknown>>
        schema: { sequences: Record<string, number> }
      }
      session: Record<string, unknown>
    }
    delete incoming.document.store['document:document'].name
    delete incoming.document.store['document:document'].meta
    delete incoming.document.store['page:page'].meta
    incoming.document.schema.sequences['com.tldraw.document'] = 0
    incoming.document.schema.sequences['com.tldraw.page'] = 0

    const target = makeStore()
    const adapter = createTldrawCanvasWriteCoordinatorEditor(makeEditor(target))
    adapter.loadInitialSnapshot(incoming as never)

    expect(target.get(TLDOCUMENT_ID)).toMatchObject({ name: '', meta: {} })
    expect(target.get(PAGE_ID)).toMatchObject({ meta: {} })
    expect(getSnapshot(target).session).toMatchObject({
      isGridMode: true,
      pageStates: [{ camera: { x: 73 } }],
    })
  })

  test('captures a stable full snapshot and a document-only view', () => {
    const store = makeStore()
    store.update(PAGE_ID, (page) => ({ ...page, name: 'Captured title' }))
    updateCamera(store, 41)
    const adapter = createTldrawCanvasWriteCoordinatorEditor(makeEditor(store))

    const full = adapter.captureSnapshot() as any
    const document = adapter.captureDocument()
    expect(full).toEqual(getSnapshot(store))
    expect(full.session.pageStates[0].camera.x).toBe(41)
    expect(document['page:page']).toMatchObject({ name: 'Captured title' })
    expect(Object.values(document).every((record) =>
      ['asset', 'binding', 'document', 'page', 'shape'].includes(record.typeName),
    )).toBe(true)

    store.update(PAGE_ID, (page) => ({ ...page, name: 'Later title' }))
    expect(full.document.store['page:page'].name).toBe('Captured title')
  })

  test('normalizes and applies document-only remote state without session or user-change echo', () => {
    const store = makeStore()
    updateCamera(store, 19)
    const beforeSession = structuredClone(getSnapshot(store).session)
    const editor = makeEditor(store)
    const adapter = createTldrawCanvasWriteCoordinatorEditor(editor)
    const userChange = vi.fn()
    store.listen(userChange, { source: 'user', scope: 'document' })
    const mergeRemote = vi.spyOn(store, 'mergeRemoteChanges')

    const remote = adapter.captureDocument()
    remote['page:page'] = { ...remote['page:page'], name: 'Remote title' }
    const changedIds = adapter.applyDocument(remote)

    expect(changedIds).toEqual(['page:page'])
    expect(store.get(PAGE_ID)).toMatchObject({ name: 'Remote title' })
    expect(getSnapshot(store).session).toEqual(beforeSession)
    expect(editor.runOptions).toContainEqual({ history: 'ignore' })
    expect(mergeRemote).toHaveBeenCalledOnce()
    expect(userChange).not.toHaveBeenCalled()
    expect(adapter.normalizeDocument(adapter.captureSnapshot())).toEqual(adapter.captureDocument())
  })

  test('reports editing end once and respects listener disposal', () => {
    const store = makeStore()
    const editor = makeEditor(store)
    const adapter = createTldrawCanvasWriteCoordinatorEditor(editor)
    const editingEnd = vi.fn()
    const unsubscribe = adapter.onEditingEnd(editingEnd)

    expect(adapter.isEditing()).toBe(false)
    setEditingShapeId(store, 'shape:editing')
    expect(adapter.isEditing()).toBe(true)
    updateCamera(store, 5)
    expect(editingEnd).not.toHaveBeenCalled()
    setEditingShapeId(store, null)
    expect(adapter.isEditing()).toBe(false)
    expect(editingEnd).toHaveBeenCalledOnce()

    setEditingShapeId(store, 'shape:editing-again')
    unsubscribe()
    setEditingShapeId(store, null)
    expect(editingEnd).toHaveBeenCalledOnce()
  })

  test('applies an accepted change-set with the exact stamp and returns changed ids', () => {
    const editor = makeChangeSetEditor()
    const adapter = createTldrawCanvasWriteCoordinatorEditor(editor)
    const changeSet: ChangeSet = {
      id: 'accepted-1',
      author: 'claude',
      ops: [{ kind: 'create_note_card', text: 'Accepted note', x: 10, y: 20 }],
    }

    const changedIds = adapter.applyAcceptedChangeSet(changeSet, 'epoch-a:17')

    expect(changedIds).toHaveLength(1)
    expect(editor.shapes.get(changedIds[0])?.meta).toEqual({
      [CHANGE_SET_STAMP_META_KEY]: 'epoch-a:17',
    })
    expect(editor.runOptions).toEqual([{ history: 'ignore' }])
  })
})
