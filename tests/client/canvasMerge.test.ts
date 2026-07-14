import { expect, test } from 'vitest'
import {
  mergeCanvasRecords,
  type CanvasMergeResult,
  type DocumentRecord,
  type DocumentRecords,
} from '../../src/client/canvasMerge'

function shape(id: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): DocumentRecord {
  return { id, typeName: 'shape', type: 'card', props, ...extra }
}

function records(...values: DocumentRecord[]): DocumentRecords {
  return Object.fromEntries(values.map((record) => [record.id, record]))
}

function documentOf(result: CanvasMergeResult): DocumentRecords {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected merge success')
  return result.document
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

test('one-sided record changes win and equal concurrent changes coalesce', () => {
  const base = records(shape('shape:a', { color: 'red' }, { x: 0 }))
  const changed = records(shape('shape:a', { color: 'red' }, { x: 10 }))

  expect(documentOf(mergeCanvasRecords({ base, local: changed, remote: base }))).toEqual(changed)
  expect(documentOf(mergeCanvasRecords({ base, local: base, remote: changed }))).toEqual(changed)
  expect(documentOf(mergeCanvasRecords({ base, local: changed, remote: changed }))).toEqual(changed)
})

test('independent creates, deletes, records, and nested object fields combine', () => {
  const base = records(
    shape('shape:delete-local'),
    shape('shape:delete-remote'),
    shape('shape:edit', { localField: 0, remoteField: 0 }),
  )
  const local = records(
    shape('shape:delete-remote'),
    shape('shape:edit', { localField: 1, remoteField: 0 }),
    shape('shape:local-create', { value: 'local' }),
    shape('shape:same-create', { value: 'same' }),
  )
  const remote = records(
    shape('shape:delete-local'),
    shape('shape:edit', { localField: 0, remoteField: 2 }),
    shape('shape:remote-create', { value: 'remote' }),
    shape('shape:same-create', { value: 'same' }),
  )

  const document = documentOf(mergeCanvasRecords({ base, local, remote }))

  expect(Object.keys(document)).toEqual([
    'shape:edit', 'shape:local-create', 'shape:remote-create', 'shape:same-create',
  ])
  expect(document['shape:edit'].props).toEqual({ localField: 1, remoteField: 2 })
})

test('all unequal additions, delete-vs-edit, scalar, and array conflicts are returned without a document', () => {
  const base = records(
    shape('shape:array', { tags: ['base'] }),
    shape('shape:delete', { value: 0 }),
    shape('shape:scalar', { value: 0 }),
  )
  const local = records(
    shape('shape:add', { value: 'local' }),
    shape('shape:array', { tags: ['local'] }),
    shape('shape:scalar', { value: 1 }),
  )
  const remote = records(
    shape('shape:add', { value: 'remote' }),
    shape('shape:array', { tags: ['remote'] }),
    shape('shape:delete', { value: 1 }),
    shape('shape:scalar', { value: 2 }),
  )

  const result = mergeCanvasRecords({ base, local, remote })

  expect(result).toEqual({
    ok: false,
    conflicts: [
      { kind: 'record-addition-conflict', recordId: 'shape:add', path: [] },
      { kind: 'field-value-conflict', recordId: 'shape:array', path: ['props', 'tags'] },
      { kind: 'record-delete-edit-conflict', recordId: 'shape:delete', path: [] },
      { kind: 'field-value-conflict', recordId: 'shape:scalar', path: ['props', 'value'] },
    ],
  })
  expect('document' in result).toBe(false)
})

test('explicit undefined fields stay distinct from missing fields', () => {
  const base = records(shape('shape:a', {}))
  const local = records(shape('shape:a', { optional: undefined }))

  const document = documentOf(mergeCanvasRecords({ base, local, remote: base }))
  const props = document['shape:a'].props as Record<string, unknown>

  expect(Object.hasOwn(props, 'optional')).toBe(true)
  expect(props.optional).toBeUndefined()
})

test('inputs are not mutated or aliased into the result', () => {
  const base = deepFreeze(records(shape('shape:a', { nested: { a: 0, b: 0 } })))
  const local = deepFreeze(records(shape('shape:a', { nested: { a: 1, b: 0 } })))
  const remote = deepFreeze(records(shape('shape:a', { nested: { a: 0, b: 2 } })))
  const before = structuredClone({ base, local, remote })

  const document = documentOf(mergeCanvasRecords({ base, local, remote }))

  expect({ base, local, remote }).toEqual(before)
  expect(document).not.toBe(base)
  expect(document['shape:a']).not.toBe(local['shape:a'])
  expect(document['shape:a'].props).not.toBe(local['shape:a'].props)
  ;((document['shape:a'].props as any).nested as any).a = 99
  expect((local['shape:a'].props as any).nested.a).toBe(1)
})

test('permuted record and object key order produces byte-identical successful output', () => {
  const first = mergeCanvasRecords({
    base: {
      'shape:z': shape('shape:z', { b: 0, a: 0 }),
      'shape:a': shape('shape:a', { d: 0, c: 0 }),
    },
    local: {
      'shape:a': shape('shape:a', { c: 1, d: 0 }),
      'shape:z': shape('shape:z', { a: 2, b: 0 }),
    },
    remote: {
      'shape:z': shape('shape:z', { b: 3, a: 0 }),
      'shape:a': shape('shape:a', { d: 4, c: 0 }),
    },
  })
  const second = mergeCanvasRecords({
    base: {
      'shape:a': shape('shape:a', { c: 0, d: 0 }),
      'shape:z': shape('shape:z', { a: 0, b: 0 }),
    },
    local: {
      'shape:z': shape('shape:z', { b: 0, a: 2 }),
      'shape:a': shape('shape:a', { d: 0, c: 1 }),
    },
    remote: {
      'shape:a': shape('shape:a', { c: 0, d: 4 }),
      'shape:z': shape('shape:z', { a: 0, b: 3 }),
    },
  })

  expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  expect(Object.keys(documentOf(first))).toEqual(['shape:a', 'shape:z'])
})

test('permuted input order produces stable conflict order', () => {
  const record = (id: string, value: number) => shape(id, { value })
  const merge = (reverse: boolean) => mergeCanvasRecords({
    base: reverse
      ? { 'shape:z': record('shape:z', 0), 'shape:a': record('shape:a', 0) }
      : { 'shape:a': record('shape:a', 0), 'shape:z': record('shape:z', 0) },
    local: reverse
      ? { 'shape:a': record('shape:a', 1), 'shape:z': record('shape:z', 1) }
      : { 'shape:z': record('shape:z', 1), 'shape:a': record('shape:a', 1) },
    remote: reverse
      ? { 'shape:z': record('shape:z', 2), 'shape:a': record('shape:a', 2) }
      : { 'shape:a': record('shape:a', 2), 'shape:z': record('shape:z', 2) },
  })

  expect(merge(false)).toEqual(merge(true))
  expect(merge(false)).toEqual({
    ok: false,
    conflicts: [
      { kind: 'field-value-conflict', recordId: 'shape:a', path: ['props', 'value'] },
      { kind: 'field-value-conflict', recordId: 'shape:z', path: ['props', 'value'] },
    ],
  })
})

test('all installed document record types are accepted at the boundary', () => {
  const document = records(
    { id: 'asset:a', typeName: 'asset' },
    { id: 'binding:a', typeName: 'binding' },
    { id: 'document:a', typeName: 'document' },
    { id: 'page:a', typeName: 'page' },
    { id: 'shape:a', typeName: 'shape' },
  )

  expect(documentOf(mergeCanvasRecords({ base: document, local: document, remote: document })))
    .toEqual(document)
})

test('non-document records and map-key identity mismatches return stable boundary conflicts', () => {
  const base = {
    __elves: { revision: 1 },
    'camera:a': { id: 'camera:a', typeName: 'camera' },
    'instance:a': { id: 'instance:a', typeName: 'instance' },
  } as unknown as DocumentRecords
  const local = {
    'presence:a': { id: 'presence:a', typeName: 'instance_presence' },
    'pointer:a': { id: 'pointer:a', typeName: 'pointer' },
  } as unknown as DocumentRecords
  const remote = {
    'shape:key': { id: 'shape:other', typeName: 'shape' },
  } as unknown as DocumentRecords

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [
      {
        kind: 'invalid-document-record', source: 'base', recordId: '__elves',
        path: [], reason: 'invalid-record',
      },
      {
        kind: 'invalid-document-record', source: 'base', recordId: 'camera:a',
        path: ['typeName'], reason: 'non-document-type',
      },
      {
        kind: 'invalid-document-record', source: 'base', recordId: 'instance:a',
        path: ['typeName'], reason: 'non-document-type',
      },
      {
        kind: 'invalid-document-record', source: 'local', recordId: 'pointer:a',
        path: ['typeName'], reason: 'non-document-type',
      },
      {
        kind: 'invalid-document-record', source: 'local', recordId: 'presence:a',
        path: ['typeName'], reason: 'non-document-type',
      },
      {
        kind: 'invalid-document-record', source: 'remote', recordId: 'shape:key',
        path: ['id'], reason: 'key-id-mismatch',
      },
    ],
  })
})
