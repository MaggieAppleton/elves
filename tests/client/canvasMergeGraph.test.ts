import { expect, test } from 'vitest'
import { mergeCanvasRecords, type DocumentRecord, type DocumentRecords } from '../../src/client/canvasMerge'

function nonShape(id: string, typeName: 'asset' | 'binding' | 'document' | 'page'): DocumentRecord {
  return { id, typeName }
}

function shape(
  id: string,
  options: { parentId?: unknown; omitParentId?: boolean; x?: number; y?: number; value?: number } = {},
): DocumentRecord {
  const record: DocumentRecord = {
    id, typeName: 'shape', type: 'group', x: options.x ?? 0, y: options.y ?? 0,
    props: { value: options.value ?? 0 },
  }
  if (!options.omitParentId) record.parentId = options.parentId ?? 'page:page'
  return record
}

function store(...records: DocumentRecord[]): DocumentRecords {
  return Object.fromEntries(records.map((record) => [record.id, record]))
}

function complete(...records: DocumentRecord[]): DocumentRecords {
  return store(
    nonShape('document:document', 'document'),
    nonShape('page:page', 'page'),
    ...records,
  )
}

function mergeSame(document: DocumentRecords) {
  return mergeCanvasRecords({ base: document, local: document, remote: document })
}

function mergedDocument(document: DocumentRecords): DocumentRecords {
  const result = mergeSame(document)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected successful graph merge')
  return result.document
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

test('valid nested shape parents preserve local coordinates', () => {
  const document = complete(
    shape('shape:group', { x: 100, y: 200 }),
    shape('shape:child', { parentId: 'shape:group', x: 12, y: 18 }),
  )

  const merged = mergedDocument(document)

  expect(merged['shape:child']).toMatchObject({ parentId: 'shape:group', x: 12, y: 18 })
})

test.each([
  { label: 'missing', record: shape('shape:a', { omitParentId: true }), reason: 'missing-parent-id' },
  { label: 'non-string', record: shape('shape:a', { parentId: 42 }), reason: 'non-string-parent-id' },
])('$label parentId returns a direct typed conflict', ({ record, reason }) => {
  expect(mergeSame(complete(record))).toEqual({
    ok: false,
    conflicts: [{
      kind: 'invalid-shape-parent', recordId: 'shape:a', path: ['parentId'], reason,
    }],
  })
})

test('a complete store with a missing referenced page conflicts', () => {
  const document = store(
    nonShape('document:document', 'document'),
    shape('shape:a', { parentId: 'page:missing' }),
  )

  expect(mergeSame(document)).toEqual({
    ok: false,
    conflicts: [{
      kind: 'invalid-shape-parent', recordId: 'shape:a', path: ['parentId'],
      reason: 'missing-parent',
    }],
  })
})

test.each([
  { typeName: 'asset' as const, id: 'asset:a' },
  { typeName: 'binding' as const, id: 'binding:a' },
  { typeName: 'document' as const, id: 'document:document' },
])('$typeName records cannot be shape parents', ({ typeName, id }) => {
  const records = typeName === 'document'
    ? complete(shape('shape:a', { parentId: id }))
    : complete(nonShape(id, typeName), shape('shape:a', { parentId: id }))

  expect(mergeSame(records)).toEqual({
    ok: false,
    conflicts: [{
      kind: 'invalid-shape-parent', recordId: 'shape:a', path: ['parentId'],
      reason: 'invalid-parent-type',
    }],
  })
})

test('self and multi-node cycles return one canonical conflict per cycle', () => {
  const document = complete(
    shape('shape:self', { parentId: 'shape:self' }),
    shape('shape:c', { parentId: 'shape:b' }),
    shape('shape:b', { parentId: 'shape:c' }),
  )

  expect(mergeSame(document)).toEqual({
    ok: false,
    conflicts: [
      {
        kind: 'shape-parent-cycle', recordId: 'shape:b', path: ['parentId'],
        cycleIds: ['shape:b', 'shape:c'],
      },
      {
        kind: 'shape-parent-cycle', recordId: 'shape:self', path: ['parentId'],
        cycleIds: ['shape:self'],
      },
    ],
  })
})

test('deleting a group leaves its surviving child as a missing-parent conflict', () => {
  const group = shape('shape:group')
  const child = shape('shape:child', { parentId: 'shape:group' })
  const base = complete(group, child)
  const local = complete(child)

  expect(mergeCanvasRecords({ base, local, remote: base })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'invalid-shape-parent', recordId: 'shape:child', path: ['parentId'],
      reason: 'missing-parent',
    }],
  })
})

test('deleting the document marker cannot bypass a newly introduced parent cycle', () => {
  const a = shape('shape:a')
  const b = shape('shape:b')
  const base = complete(a, b)
  const local = store(
    nonShape('page:page', 'page'),
    shape('shape:a', { parentId: 'shape:b' }),
    shape('shape:b', { parentId: 'shape:a' }),
  )

  expect(mergeCanvasRecords({ base, local, remote: base })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'shape-parent-cycle', recordId: 'shape:a', path: ['parentId'],
      cycleIds: ['shape:a', 'shape:b'],
    }],
  })
})

test('non-shape records are ignored when they are not used as parents', () => {
  const document = complete(
    nonShape('asset:a', 'asset'),
    nonShape('binding:a', 'binding'),
    shape('shape:a'),
  )

  expect(mergeSame(document).ok).toBe(true)
})

test('partial shape-only maps retain generic merge compatibility', () => {
  const partial = store(shape('shape:a', { omitParentId: true }))

  expect(mergeSame(partial)).toEqual({ ok: true, document: partial })
})

test('earlier structural conflicts take precedence over graph validation', () => {
  const baseShape = shape('shape:a', { omitParentId: true, value: 0 })
  const localShape = shape('shape:a', { omitParentId: true, value: 1 })
  const remoteShape = shape('shape:a', { omitParentId: true, value: 2 })

  expect(mergeCanvasRecords({
    base: complete(baseShape), local: complete(localShape), remote: complete(remoteShape),
  })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'field-value-conflict', recordId: 'shape:a', path: ['props', 'value'],
    }],
  })
})

test('permuted record keys produce byte-identical, stably ordered graph conflicts', () => {
  const records = [
    nonShape('document:document', 'document'),
    nonShape('page:page', 'page'),
    shape('shape:z', { parentId: 'shape:missing' }),
    shape('shape:a', { parentId: 42 }),
    shape('shape:c', { parentId: 'shape:b' }),
    shape('shape:b', { parentId: 'shape:c' }),
  ]
  const forward = mergeSame(store(...records))
  const reverse = mergeSame(store(...[...records].reverse()))

  expect(forward).toEqual(reverse)
  expect(forward).toEqual({
    ok: false,
    conflicts: [
      {
        kind: 'invalid-shape-parent', recordId: 'shape:a', path: ['parentId'],
        reason: 'non-string-parent-id',
      },
      {
        kind: 'invalid-shape-parent', recordId: 'shape:z', path: ['parentId'],
        reason: 'missing-parent',
      },
      {
        kind: 'shape-parent-cycle', recordId: 'shape:b', path: ['parentId'],
        cycleIds: ['shape:b', 'shape:c'],
      },
    ],
  })
})

test('graph validation does not mutate frozen inputs', () => {
  const document = deepFreeze(complete(shape('shape:a', { parentId: 'page:missing' })))
  const input = deepFreeze({ base: document, local: document, remote: document })
  const before = JSON.parse(JSON.stringify(input))

  mergeCanvasRecords(input)

  expect(input).toEqual(before)
})

test('__proto__ parent ids use own-record lookup safely', () => {
  const protoPage = nonShape('__proto__', 'page')
  const document = complete(protoPage, shape('shape:a', { parentId: '__proto__' }))

  const merged = mergedDocument(document)

  expect(Object.hasOwn(merged, '__proto__')).toBe(true)
  expect(merged['shape:a'].parentId).toBe('__proto__')
  expect(({} as any).polluted).toBeUndefined()
})
