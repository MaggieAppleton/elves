import { expect, test } from 'vitest'
import { mergeCanvasRecords, type DocumentRecord, type DocumentRecords } from '../../src/client/canvasMerge'

function nonShape(id: string, typeName: 'document' | 'page'): DocumentRecord {
  return { id, typeName }
}

function shape(
  id: string,
  parentId: string,
  options: { type?: string; x?: number; y?: number; value?: number } = {},
): DocumentRecord {
  return {
    id, typeName: 'shape', type: options.type ?? 'group', parentId,
    x: options.x ?? 0, y: options.y ?? 0, rotation: 0,
    props: { value: options.value ?? 0 },
  }
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

function successful(input: {
  base: DocumentRecords
  local: DocumentRecords
  remote: DocumentRecords
}): DocumentRecords {
  const result = mergeCanvasRecords(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected successful structural merge')
  return result.document
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

test('ancestor and child reparenting conflict even when the merged graph is valid', () => {
  const targetA = shape('shape:target-a', 'page:page')
  const targetB = shape('shape:target-b', 'page:page')
  const ancestor = shape('shape:ancestor', 'page:page')
  const child = shape('shape:child', 'shape:ancestor', { type: 'geo' })
  const base = complete(targetA, targetB, ancestor, child)
  const local = complete(targetA, targetB, { ...ancestor, parentId: 'shape:target-a' }, child)
  const remote = complete(targetA, targetB, ancestor, { ...child, parentId: 'shape:target-b' })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'shape-structure-overlap', recordId: 'shape:ancestor', path: ['structure'],
      shapeIds: ['shape:ancestor', 'shape:child'],
    }],
  })
})

test('group deletion conflicts with concurrent child reparenting', () => {
  const group = shape('shape:group', 'page:page')
  const child = shape('shape:child', 'shape:group', { type: 'geo' })
  const base = complete(group, child)
  const local = complete(child)
  const remote = complete(group, { ...child, parentId: 'page:page' })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'shape-structure-overlap', recordId: 'shape:child', path: ['structure'],
      shapeIds: ['shape:child', 'shape:group'],
    }],
  })
})

test('an added group joins its connected ancestor-child overlap component', () => {
  const a = shape('shape:a', 'page:page')
  const b = shape('shape:b', 'shape:a', { type: 'geo' })
  const addedGroup = shape('shape:g', 'page:page')
  const base = complete(a, b)
  const local = complete({ ...a, parentId: 'shape:g' }, b, addedGroup)
  const remote = complete(a, { ...b, parentId: 'page:page' })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'shape-structure-overlap', recordId: 'shape:a', path: ['structure'],
      shapeIds: ['shape:a', 'shape:b', 'shape:g'],
    }],
  })
})

test.each([
  {
    label: 'same reparent',
    baseRecords: [shape('shape:target', 'page:page'), shape('shape:item', 'page:page', { type: 'geo' })],
    changedRecords: [
      shape('shape:target', 'page:page'),
      shape('shape:item', 'shape:target', { type: 'geo' }),
    ],
    shapeId: 'shape:item',
    parentId: 'shape:target',
  },
  {
    label: 'same group addition',
    baseRecords: [],
    changedRecords: [shape('shape:group', 'page:page')],
    shapeId: 'shape:group',
    parentId: 'page:page',
  },
])('$label on both sides coalesces', ({
  baseRecords, changedRecords, shapeId, parentId,
}) => {
  const base = complete(...baseRecords)
  const changed = complete(...changedRecords)

  const merged = successful({ base, local: changed, remote: changed })

  expect(merged[shapeId].parentId).toBe(parentId)
})

test('disjoint reparent and group addition combine', () => {
  const left = shape('shape:left', 'page:page')
  const right = shape('shape:right', 'page:page')
  const child = shape('shape:child', 'shape:left', { type: 'geo' })
  const base = complete(left, right, child)
  const local = complete(left, right, { ...child, parentId: 'page:page' })
  const added = shape('shape:new-group', 'shape:right')
  const remote = complete(left, right, child, added)

  const merged = successful({ base, local, remote })

  expect(merged['shape:child'].parentId).toBe('page:page')
  expect(merged['shape:new-group'].parentId).toBe('shape:right')
})

test('ordinary child prop edits combine with ancestor reparenting', () => {
  const target = shape('shape:target', 'page:page')
  const ancestor = shape('shape:ancestor', 'page:page')
  const child = shape('shape:child', 'shape:ancestor', { type: 'geo', value: 0 })
  const base = complete(target, ancestor, child)
  const local = complete(target, { ...ancestor, parentId: 'shape:target' }, child)
  const remote = complete(target, ancestor, {
    ...child, props: { value: 1 },
  })

  const merged = successful({ base, local, remote })

  expect(merged['shape:ancestor'].parentId).toBe('shape:target')
  expect(merged['shape:child'].props).toEqual({ value: 1 })
})

test('x/y-only ancestor and child moves are not structural deltas', () => {
  const ancestor = shape('shape:ancestor', 'page:page')
  const child = shape('shape:child', 'shape:ancestor', { type: 'geo' })
  const base = complete(ancestor, child)
  const local = complete({ ...ancestor, x: 50 }, child)
  const remote = complete(ancestor, { ...child, y: 75 })

  const merged = successful({ base, local, remote })

  expect(merged['shape:ancestor'].x).toBe(50)
  expect(merged['shape:child'].y).toBe(75)
})

test('generic same-record layout conflicts take precedence', () => {
  const targetA = shape('shape:target-a', 'page:page')
  const targetB = shape('shape:target-b', 'page:page')
  const item = shape('shape:item', 'page:page', { type: 'geo' })
  const base = complete(targetA, targetB, item)
  const local = complete(targetA, targetB, { ...item, parentId: 'shape:target-a' })
  const remote = complete(targetA, targetB, { ...item, parentId: 'shape:target-b' })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{ kind: 'atomic-field-conflict', recordId: 'shape:item', path: ['layout'] }],
  })
})

function componentFixture(reverse: boolean) {
  const targetA = shape('shape:target-a', 'page:page')
  const targetB = shape('shape:target-b', 'page:page')
  const a = shape('shape:a', 'page:page')
  const b = shape('shape:b', 'shape:a')
  const c = shape('shape:c', 'shape:b', { type: 'geo' })
  const x = shape('shape:x', 'page:page')
  const y = shape('shape:y', 'shape:x', { type: 'geo' })
  const baseRecords = [targetA, targetB, a, b, c, x, y]
  const localRecords = [
    targetA, targetB, { ...a, parentId: 'shape:target-a' }, b,
    { ...c, parentId: 'shape:target-a' }, { ...x, parentId: 'shape:target-a' }, y,
  ]
  const remoteRecords = [
    targetA, targetB, a, { ...b, parentId: 'shape:target-b' }, c, x,
    { ...y, parentId: 'shape:target-b' },
  ]
  const ordered = (records: DocumentRecord[]) => reverse ? [...records].reverse() : records
  return {
    base: complete(...ordered(baseRecords)),
    local: complete(...ordered(localRecords)),
    remote: complete(...ordered(remoteRecords)),
  }
}

test('overlap pairs collapse into deterministic connected components', () => {
  const forward = mergeCanvasRecords(componentFixture(false))
  const reverse = mergeCanvasRecords(componentFixture(true))

  expect(forward).toEqual(reverse)
  expect(forward).toEqual({
    ok: false,
    conflicts: [
      {
        kind: 'shape-structure-overlap', recordId: 'shape:a', path: ['structure'],
        shapeIds: ['shape:a', 'shape:b', 'shape:c'],
      },
      {
        kind: 'shape-structure-overlap', recordId: 'shape:x', path: ['structure'],
        shapeIds: ['shape:x', 'shape:y'],
      },
    ],
  })
})

test('cyclic ancestry maps terminate and still detect related deltas', () => {
  const a = shape('shape:a', 'shape:b')
  const b = shape('shape:b', 'shape:a')
  const base = complete(a, b)
  const local = complete({ ...a, parentId: 'page:page' }, b)
  const remote = complete(a, { ...b, parentId: 'page:page' })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'shape-structure-overlap', recordId: 'shape:a', path: ['structure'],
      shapeIds: ['shape:a', 'shape:b'],
    }],
  })
})

test('partial stores retain generic structural merge compatibility', () => {
  const targetA = shape('shape:target-a', 'page:page')
  const targetB = shape('shape:target-b', 'page:page')
  const ancestor = shape('shape:ancestor', 'page:page')
  const child = shape('shape:child', 'shape:ancestor', { type: 'geo' })
  const base = store(targetA, targetB, ancestor, child)
  const local = store(targetA, targetB, { ...ancestor, parentId: 'shape:target-a' }, child)
  const remote = store(targetA, targetB, ancestor, { ...child, parentId: 'shape:target-b' })

  expect(mergeCanvasRecords({ base, local, remote }).ok).toBe(true)
})

test('structure detection never mutates frozen inputs', () => {
  const ancestor = shape('shape:ancestor', 'page:page')
  const child = shape('shape:child', 'shape:ancestor', { type: 'geo' })
  const target = shape('shape:target', 'page:page')
  const input = deepFreeze({
    base: complete(target, ancestor, child),
    local: complete(target, { ...ancestor, parentId: 'shape:target' }, child),
    remote: complete(target, ancestor, { ...child, parentId: 'page:page' }),
  })
  const before = JSON.parse(JSON.stringify(input))

  mergeCanvasRecords(input)

  expect(input).toEqual(before)
})
