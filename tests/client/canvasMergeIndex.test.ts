import { expect, test } from 'vitest'
import { mergeCanvasRecords, type DocumentRecord, type DocumentRecords } from '../../src/client/canvasMerge'

function nonShape(id: string, typeName: 'document' | 'page'): DocumentRecord {
  return { id, typeName }
}

function shape(
  id: string,
  parentId: string,
  index: unknown,
  options: { omitIndex?: boolean; x?: number; value?: number; meta?: Record<string, unknown> } = {},
): DocumentRecord {
  const record: DocumentRecord = {
    id, typeName: 'shape', type: 'geo', parentId,
    x: options.x ?? 0, y: 0, rotation: 0,
    props: { value: options.value ?? 0 },
  }
  if (!options.omitIndex) record.index = index
  if (options.meta) record.meta = options.meta
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

function successful(input: {
  base: DocumentRecords
  local: DocumentRecords
  remote: DocumentRecords
}): DocumentRecords {
  const result = mergeCanvasRecords(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected successful index repair')
  return result.document
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

test('remote and local independent additions at the same top index are repaired in provenance order', () => {
  const lower = shape('shape:lower', 'page:page', 'a0')
  const localOnly = shape('shape:a-local', 'page:page', 'a1')
  const remoteBacked = shape('shape:z-remote', 'page:page', 'a1')
  const base = complete(lower)
  const local = complete(lower, localOnly)
  const remote = complete(lower, remoteBacked)

  const merged = successful({ base, local, remote })

  expect(merged['shape:lower'].index).toBe('a0')
  expect(merged['shape:z-remote'].index).toBe('a1')
  expect(merged['shape:a-local'].index).toBe('a2')
})

test('an existing remote-backed record sorts before a local-only collision', () => {
  const lower = shape('shape:lower', 'page:page', 'a0')
  const existing = shape('shape:z-existing', 'page:page', 'a1', {
    x: 12, value: 7, meta: { keep: true },
  })
  const upper = shape('shape:upper', 'page:page', 'a2')
  const localOnly = shape('shape:a-local', 'page:page', 'a1')
  const base = complete(lower, existing, upper)
  const local = complete(lower, existing, upper, localOnly)

  const merged = successful({ base, local, remote: base })

  expect(merged['shape:lower'].index).toBe('a0')
  expect(merged['shape:z-existing']).toMatchObject({
    index: 'a0V', x: 12, props: { value: 7 }, meta: { keep: true },
  })
  expect(merged['shape:a-local'].index).toBe('a1')
  expect(merged['shape:upper'].index).toBe('a2')
})

test('adjacent collision runs are processed sequentially without interleaving', () => {
  const lower = shape('shape:lower', 'page:page', 'a0')
  const first = shape('shape:z-first', 'page:page', 'a1')
  const second = shape('shape:z-second', 'page:page', 'a2')
  const upper = shape('shape:upper', 'page:page', 'a3')
  const localFirst = shape('shape:a-local-first', 'page:page', 'a1')
  const localSecond = shape('shape:a-local-second', 'page:page', 'a2')
  const base = complete(lower, first, second, upper)
  const local = complete(lower, first, second, upper, localFirst, localSecond)

  const merged = successful({ base, local, remote: base })

  expect([
    merged['shape:lower'].index,
    merged['shape:z-first'].index,
    merged['shape:a-local-first'].index,
    merged['shape:z-second'].index,
    merged['shape:a-local-second'].index,
    merged['shape:upper'].index,
  ]).toEqual(['a0', 'a0V', 'a1', 'a1V', 'a2', 'a3'])
})

test('equal indices under different parents do not collide', () => {
  const pageA = nonShape('page:a', 'page')
  const pageB = nonShape('page:b', 'page')
  const a = shape('shape:a', 'page:a', 'a1')
  const b = shape('shape:b', 'page:b', 'a1')
  const document = complete(pageA, pageB, a, b)

  const merged = successful({ base: document, local: document, remote: document })

  expect(merged['shape:a'].index).toBe('a1')
  expect(merged['shape:b'].index).toBe('a1')
})

test('singletons and equal same-id additions keep their indices', () => {
  const singleton = shape('shape:singleton', 'page:page', 'a1')
  const unchanged = complete(singleton)
  expect(successful({ base: unchanged, local: unchanged, remote: unchanged })['shape:singleton'].index)
    .toBe('a1')

  const added = shape('shape:added', 'page:page', 'a1')
  const base = complete()
  const equalAddition = complete(added)
  expect(successful({ base, local: equalAddition, remote: equalAddition })['shape:added'].index)
    .toBe('a1')
})

test('partial stores skip index repair', () => {
  const a = shape('shape:a', 'page:page', 'a1')
  const b = shape('shape:b', 'page:page', 'a1')
  const partial = store(a, b)

  const merged = successful({ base: partial, local: partial, remote: partial })

  expect(merged['shape:a'].index).toBe('a1')
  expect(merged['shape:b'].index).toBe('a1')
})

test('missing and non-string indices are ignored without throwing', () => {
  const missing = shape('shape:missing', 'page:page', undefined, { omitIndex: true })
  const numeric = shape('shape:numeric', 'page:page', 42)
  const valid = shape('shape:valid', 'page:page', 'a1')
  const document = complete(missing, numeric, valid)

  const merged = successful({ base: document, local: document, remote: document })

  expect(Object.hasOwn(merged['shape:missing'], 'index')).toBe(false)
  expect(merged['shape:numeric'].index).toBe(42)
  expect(merged['shape:valid'].index).toBe('a1')
})

function provenanceInput(reverse: boolean) {
  const lower = shape('shape:lower', 'page:page', 'a0')
  const upper = shape('shape:upper', 'page:page', 'a5')
  const local = [
    shape('shape:b-local', 'page:page', 'a2'),
    shape('shape:a-local', 'page:page', 'a2'),
  ]
  const remote = [
    shape('shape:z-remote', 'page:page', 'a2'),
    shape('shape:y-remote', 'page:page', 'a2'),
  ]
  const ordered = (records: DocumentRecord[]) => reverse ? [...records].reverse() : records
  return {
    base: complete(...ordered([lower, upper])),
    local: complete(...ordered([lower, upper, ...local])),
    remote: complete(...ordered([lower, upper, ...remote])),
  }
}

test('provenance ordering is remote-backed first, then local-only, then id', () => {
  const merged = successful(provenanceInput(false))
  const runIds = ['shape:y-remote', 'shape:z-remote', 'shape:a-local', 'shape:b-local']
  expect(new Set(runIds.map((recordId) => merged[recordId].index)).size).toBe(4)
  const idsByGeneratedIndex = runIds.sort((left, right) =>
    (merged[left].index as string) < (merged[right].index as string) ? -1 : 1)

  expect(idsByGeneratedIndex).toEqual([
    'shape:y-remote', 'shape:z-remote', 'shape:a-local', 'shape:b-local',
  ])
})

test('repair is byte-deterministic across permutations and repeated calls', () => {
  const forward = provenanceInput(false)
  const reverse = provenanceInput(true)

  const first = successful(forward)
  const repeated = successful(forward)
  const permuted = successful(reverse)

  expect(JSON.stringify(first)).toBe(JSON.stringify(repeated))
  expect(JSON.stringify(first)).toBe(JSON.stringify(permuted))
  expect(new Set([
    first['shape:y-remote'].index,
    first['shape:z-remote'].index,
    first['shape:a-local'].index,
    first['shape:b-local'].index,
  ]).size).toBe(4)
})

test('index repair never mutates frozen inputs', () => {
  const input = deepFreeze(provenanceInput(false))
  const before = JSON.parse(JSON.stringify(input))

  successful(input)

  expect(input).toEqual(before)
})

test('__proto__ parent ids are grouped safely', () => {
  const protoPage = nonShape('__proto__', 'page')
  const a = shape('shape:a', '__proto__', 'a1')
  const b = shape('shape:b', '__proto__', 'a1')
  const document = complete(protoPage, a, b)

  const merged = successful({ base: document, local: document, remote: document })

  expect(Object.hasOwn(merged, '__proto__')).toBe(true)
  expect(merged['shape:a'].index).not.toBe(merged['shape:b'].index)
  expect(({} as any).polluted).toBeUndefined()
})
