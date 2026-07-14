import {
  atom, computed, react,
  type Computed, type Editor, type TLParentId, type TLShape, type TLShapeId,
} from 'tldraw'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  __cardPageIndexDiagnosticsForTests,
  cardPageInfo,
  expandedCardFanInfo,
} from '../../src/shapes/cardPageIndex'

interface ReactiveEditorHarness {
  editor: Editor
  pageIdReads: () => number
  cacheRuns: (name: string) => number
  cacheEntries: (name: string) => number
  cacheCreates: (name: string) => number
  liveRecordCount: () => number
  addShape: (shape: TLShape, onCurrentPage?: boolean) => void
  deleteShape: (id: TLShapeId) => void
  setCurrentPage: (ids: TLShapeId[]) => void
  updateShape: (id: TLShapeId, update: Partial<TLShape> & { props?: Record<string, unknown> }) => void
}

const stops: Array<() => void> = []

afterEach(() => {
  while (stops.length) stops.pop()?.()
  vi.restoreAllMocks()
})

function card(
  id: string,
  options: { x?: number; y?: number; mergedInto?: string | null; text?: string } = {},
): TLShape {
  return {
    id: id as TLShapeId,
    typeName: 'shape',
    type: 'card',
    x: options.x ?? 0,
    y: options.y ?? 0,
    rotation: 0,
    index: 'a1' as TLShape['index'],
    parentId: 'page:page' as TLParentId,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      mergedInto: options.mergedInto ?? null,
      text: options.text ?? id,
    },
  } as TLShape
}

function otherShape(id: string, x = 0, y = 0): TLShape {
  return { ...card(id, { x, y }), type: 'question', props: { dismissed: false } } as TLShape
}

function reactiveEditor(shapes: TLShape[]): ReactiveEditorHarness {
  const ids = atom<ReadonlySet<TLShapeId>>(
    'test current page ids',
    new Set(shapes.map((shape) => shape.id)),
  )
  const records = new Map(shapes.map((shape) => [
    shape.id,
    atom<TLShape>(`test record ${shape.id}`, shape),
  ]))
  const runs = new Map<string, number>()
  const cacheCreates = new Map<string, number>()
  const recordCaches: Array<Map<object, Computed<unknown>>> = []
  let idReads = 0

  const store = {
    createCache(
      create: (id: TLShapeId, record: Computed<TLShape>) => Computed<unknown>,
    ) {
      const values = new Map<object, Computed<unknown>>()
      recordCaches.push(values)
      return {
        get(id: TLShapeId) {
          const record = records.get(id)
          if (!record) return undefined
          let value = values.get(record)
          if (!value) {
            value = create(id, record as unknown as Computed<TLShape>)
            values.set(record, value)
            cacheCreates.set(value.name, (cacheCreates.get(value.name) ?? 0) + 1)
          }
          return value.get()
        },
      }
    },
    createComputedCache(
      name: string,
      derive: (record: TLShape) => unknown,
      options?: {
        areRecordsEqual?: (a: TLShape, b: TLShape) => boolean
        areResultsEqual?: (a: unknown, b: unknown) => boolean
      },
    ) {
      const values = new Map<TLShapeId, Computed<unknown>>()
      return {
        get(id: TLShapeId) {
          let value = values.get(id)
          if (!value) {
            const record = computed(
              `${name} record ${id}`,
              () => records.get(id)!.get(),
              { isEqual: options?.areRecordsEqual },
            )
            value = computed(name, () => {
              runs.set(name, (runs.get(name) ?? 0) + 1)
              return derive(record.get())
            }, { isEqual: options?.areResultsEqual })
            values.set(id, value)
          }
          return value.get()
        },
      }
    },
  }

  const editor = {
    store,
    getCurrentPageShapeIds() {
      idReads += 1
      return ids.get()
    },
    getShape(id: TLShapeId) {
      return records.get(id)?.get()
    },
  } as unknown as Editor

  return {
    editor,
    pageIdReads: () => idReads,
    cacheRuns: (name) => runs.get(name) ?? 0,
    cacheEntries: (name) => recordCaches.reduce(
      (count, cache) => count + [...cache.values()].filter((value) => value.name.startsWith(name)).length,
      0,
    ),
    cacheCreates: (name) => [...cacheCreates.entries()].reduce(
      (count, [signalName, creates]) => count + (signalName.startsWith(name) ? creates : 0),
      0,
    ),
    liveRecordCount: () => records.size,
    addShape(shape, onCurrentPage = false) {
      records.set(shape.id, atom<TLShape>(`test record ${shape.id}`, shape))
      if (onCurrentPage) ids.set(new Set([...ids.get(), shape.id]))
    },
    deleteShape(id) {
      const record = records.get(id)
      if (!record) return
      records.delete(id)
      for (const cache of recordCaches) cache.delete(record)
      if (ids.get().has(id)) ids.set(new Set([...ids.get()].filter((shapeId) => shapeId !== id)))
    },
    setCurrentPage: (currentIds) => ids.set(new Set(currentIds)),
    updateShape(id, update) {
      const record = records.get(id)
      if (!record) throw new Error(`missing test shape ${id}`)
      const previous = record.get()
      record.set({
        ...previous,
        ...update,
        props: update.props ? { ...previous.props, ...update.props } : previous.props,
      } as TLShape)
    },
  }
}

describe('cardPageInfo', () => {
  test('100 card consumers share one scan and ignore a move-only update', () => {
    const shapes = Array.from({ length: 100 }, (_, index) =>
      card(`shape:card-${String(index).padStart(3, '0')}`),
    )
    const harness = reactiveEditor(shapes)
    const diagnostics = __cardPageIndexDiagnosticsForTests(harness.editor)
    const originalIndexOf = Array.prototype.indexOf
    let linearNumberScans = 0
    vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (
      this: unknown[],
      searchElement: unknown,
      fromIndex?: number,
    ) {
      if (this.length === shapes.length && this[0] === shapes[0].id) linearNumberScans += 1
      return originalIndexOf.call(this, searchElement, fromIndex)
    })
    const consumerRuns = new Map<TLShapeId, number>()
    for (const shape of shapes) {
      stops.push(react(`test consumer ${shape.id}`, () => {
        cardPageInfo(harness.editor, shape.id as TLShapeId)
        consumerRuns.set(shape.id, (consumerRuns.get(shape.id) ?? 0) + 1)
      }))
    }

    expect(harness.pageIdReads()).toBe(1)
    expect(diagnostics.pageScans).toBe(1)
    expect(diagnostics.cardNumberLookups).toBe(100)
    expect(linearNumberScans).toBe(0)
    harness.updateShape(shapes[50].id, { x: 900, y: 400 })

    expect(harness.pageIdReads()).toBe(1)
    expect([...consumerRuns.values()]).toEqual(Array(100).fill(1))
  })

  test('a merge-membership update reruns only the affected representative consumer', () => {
    const representative = card('shape:a')
    const member = card('shape:b')
    const unrelated = card('shape:c')
    const harness = reactiveEditor([representative, member, unrelated])
    const consumerRuns = new Map<TLShapeId, number>()
    for (const shape of [representative, member, unrelated]) {
      stops.push(react(`test consumer ${shape.id}`, () => {
        cardPageInfo(harness.editor, shape.id as TLShapeId)
        consumerRuns.set(shape.id, (consumerRuns.get(shape.id) ?? 0) + 1)
      }))
    }

    harness.updateShape(member.id, { props: { mergedInto: representative.id } })

    expect(harness.pageIdReads()).toBe(2)
    expect(consumerRuns.get(representative.id)).toBe(2)
    expect(consumerRuns.get(member.id)).toBe(1)
    expect(consumerRuns.get(unrelated.id)).toBe(1)
  })

  test('preserves lexicographic numbering and page-order merged members', () => {
    const harness = reactiveEditor([
      card('shape:z'),
      card('shape:member-2', { mergedInto: 'shape:z' }),
      card('shape:a'),
      card('shape:member-1', { mergedInto: 'shape:z' }),
      otherShape('shape:question'),
    ])

    expect(cardPageInfo(harness.editor, 'shape:a' as TLShapeId)).toEqual({
      cardNumber: 1,
      cardCount: 4,
      memberIds: [],
    })
    expect(cardPageInfo(harness.editor, 'shape:z' as TLShapeId)).toEqual({
      cardNumber: 4,
      cardCount: 4,
      memberIds: ['shape:member-2', 'shape:member-1'],
    })
  })

  test('selector cache follows live records through page switches, retyping, and delete churn', () => {
    const first = card('shape:first')
    const second = card('shape:second')
    const harness = reactiveEditor([first, second])

    harness.setCurrentPage([first.id])
    const firstInfo = cardPageInfo(harness.editor, first.id as TLShapeId)
    expect(harness.cacheEntries('card page info')).toBe(1)

    harness.setCurrentPage([second.id])
    cardPageInfo(harness.editor, second.id as TLShapeId)
    harness.setCurrentPage([first.id])
    expect(cardPageInfo(harness.editor, first.id as TLShapeId)).toBe(firstInfo)
    expect(harness.cacheCreates('card page info')).toBe(2)

    harness.updateShape(first.id, { type: 'question', props: { mergedInto: null } })
    harness.setCurrentPage([second.id])
    harness.updateShape(first.id, { type: 'card', props: { mergedInto: null } })
    harness.setCurrentPage([first.id])
    cardPageInfo(harness.editor, first.id as TLShapeId)
    expect(harness.cacheCreates('card page info')).toBe(2)

    for (let index = 0; index < 20; index += 1) {
      const temporary = card(`shape:temporary-${index}`)
      harness.addShape(temporary)
      harness.setCurrentPage([temporary.id])
      cardPageInfo(harness.editor, temporary.id as TLShapeId)
      harness.deleteShape(temporary.id)
      expect(harness.cacheEntries('card page info')).toBeLessThanOrEqual(harness.liveRecordCount())
    }
    expect(harness.cacheEntries('card page info')).toBe(2)
  })
})

describe('expandedCardFanInfo', () => {
  test('fan layout work is lazy, shared while expanded, and inactive after disposal', () => {
    const representative = card('shape:a')
    const member = card('shape:b', { mergedInto: representative.id })
    const obstacle = otherShape('shape:q', 40, 60)
    const harness = reactiveEditor([representative, member, obstacle])

    cardPageInfo(harness.editor, representative.id as TLShapeId)
    expect(harness.cacheRuns('card fan layout record')).toBe(0)
    expect(harness.pageIdReads()).toBe(1)
    harness.updateShape(obstacle.id, { x: 80 })
    expect(harness.cacheRuns('card fan layout record')).toBe(0)
    expect(harness.pageIdReads()).toBe(1)

    let fanRuns = 0
    const stop = react('test expanded fan', () => {
      expandedCardFanInfo(harness.editor, representative.id as TLShapeId)
      fanRuns += 1
    })
    expect(harness.pageIdReads()).toBe(2)
    expect(harness.cacheRuns('card fan layout record')).toBe(3)

    harness.updateShape(obstacle.id, { y: 120 })
    expect(harness.pageIdReads()).toBe(3)
    expect(fanRuns).toBe(2)

    stop()
    harness.updateShape(obstacle.id, { y: 180 })
    expect(harness.pageIdReads()).toBe(3)
  })

  test('returns the legacy layout key and current member records', () => {
    const representative = card('shape:a', { x: 10, y: 20 })
    const member = card('shape:b', { x: 30, y: 40, mergedInto: representative.id, text: 'member' })
    const harness = reactiveEditor([representative, member])

    const fan = expandedCardFanInfo(harness.editor, representative.id as TLShapeId)

    expect(fan.layoutKey).toBe(
      'shape:a:10:20:page:page|shape:b:30:40:page:page',
    )
    expect(fan.members).toEqual([member])
  })

  test('collapsed fans retain no selector result or deleted full member record', () => {
    const representative = card('shape:a')
    const member = card('shape:b', { mergedInto: representative.id, text: 'deleted member body' })
    const harness = reactiveEditor([representative, member])
    let fan!: ReturnType<typeof expandedCardFanInfo>
    const collapse = react('test fan consumer', () => {
      fan = expandedCardFanInfo(harness.editor, representative.id as TLShapeId)
    })
    expect(fan.members).toEqual([member])
    collapse()
    expect(expandedCardFanInfo(harness.editor, representative.id as TLShapeId)).not.toBe(fan)
    harness.deleteShape(member.id)

    expect(expandedCardFanInfo(harness.editor, representative.id as TLShapeId).members).toEqual([])
  })
})
