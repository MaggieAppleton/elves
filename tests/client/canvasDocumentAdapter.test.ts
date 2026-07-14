import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createTLStore,
  defaultShapeUtils,
  getSnapshot,
  type TLCameraId,
  type TLPageId,
  type TLStore,
  type TLStoreSnapshot,
} from 'tldraw'
import {
  applyCanvasDocument,
  captureCanvasDocument,
  diffCanvasDocuments,
  normalizeCanvasDocument,
} from '../../src/client/canvasDocumentAdapter'

const stores: TLStore[] = []

function makeStore() {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  ;(store as TLStore & { ensureStoreIsUsable(): void }).ensureStoreIsUsable()
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
})

describe('canvas document adapter', () => {
  test('captures document records without session records', () => {
    const store = makeStore()

    const document = captureCanvasDocument(store)

    expect(Object.keys(document)).toContain('document:document')
    expect(Object.keys(document)).toContain('page:page')
    expect(Object.values(document).every((record) =>
      ['asset', 'binding', 'document', 'page', 'shape'].includes(record.typeName),
    )).toBe(true)
    expect(Object.keys(document).some((id) => id.startsWith('camera:'))).toBe(false)
    expect(Object.keys(document).some((id) => id.startsWith('instance:'))).toBe(false)
  })

  test('normalizes a fetched editor document through the live store schema', () => {
    const source = makeStore()
    const incoming = structuredClone(source.getStoreSnapshot()) as unknown as {
      store: Record<string, Record<string, unknown>>
      schema: { schemaVersion: number; sequences: Record<string, number> }
    }
    delete (incoming.store['document:document'] as Record<string, unknown>).name
    delete (incoming.store['document:document'] as Record<string, unknown>).meta
    delete (incoming.store['page:page'] as Record<string, unknown>).meta
    incoming.schema.sequences['com.tldraw.document'] = 0
    incoming.schema.sequences['com.tldraw.page'] = 0

    const target = makeStore()
    const normalized = normalizeCanvasDocument(target, {
      document: incoming as unknown as TLStoreSnapshot,
    })

    expect(normalized['page:page']).toMatchObject({
      id: 'page:page',
      typeName: 'page',
      meta: {},
    })
    expect(normalized['document:document']).toMatchObject({ name: '', meta: {} })
    expect(normalized).not.toBe(incoming.store)
  })

  test('normalizes an empty fetched canvas to an empty document', () => {
    expect(normalizeCanvasDocument(makeStore(), { document: null })).toEqual({})
  })

  test('builds deterministic added, updated, and removed record diffs', () => {
    const before = {
      'page:a': { id: 'page:a', typeName: 'page' as const, name: 'A' },
      'page:b': { id: 'page:b', typeName: 'page' as const, name: 'B' },
    }
    const after = {
      'page:a': { id: 'page:a', typeName: 'page' as const, name: 'A2' },
      'page:c': { id: 'page:c', typeName: 'page' as const, name: 'C' },
    }

    expect(diffCanvasDocuments(before, after)).toEqual({
      added: { 'page:c': after['page:c'] },
      updated: { 'page:a': [before['page:a'], after['page:a']] },
      removed: { 'page:b': before['page:b'] },
    })
  })

  test('applies only document records as remote changes and preserves session state', () => {
    const store = makeStore()
    store.update('camera:page:page' as TLCameraId, (camera) => ({
      ...camera,
      x: 42,
      y: -17,
      z: 2,
    }))
    const beforeSession = structuredClone(getSnapshot(store).session)
    const onUserChange = vi.fn()
    store.listen(onUserChange, { source: 'user', scope: 'document' })

    const remote = captureCanvasDocument(store)
    remote['page:page'] = { ...remote['page:page'], name: 'Remote title' }
    const changedIds = applyCanvasDocument(store, remote)

    expect(store.get('page:page' as TLPageId)).toMatchObject({ name: 'Remote title' })
    expect(changedIds).toEqual(['page:page'])
    expect(getSnapshot(store).session).toEqual(beforeSession)
    expect(onUserChange).not.toHaveBeenCalled()
  })
})
