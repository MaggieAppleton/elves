import { expect, test } from 'vitest'
import {
  mergeCanvasRecords,
  type CanvasMergeResult,
  type DocumentRecord,
  type DocumentRecords,
} from '../../src/client/canvasMerge'

function attribution(text: string, author: string) {
  return text ? [{ author, length: text.length }] : []
}

function card(options: {
  text?: string
  authoredBy?: string | null
  x?: number
  y?: number
  comments?: unknown[]
  draftExcluded?: boolean
} = {}): DocumentRecord {
  const text = options.text ?? 'base'
  const authoredBy = options.authoredBy ?? null
  return {
    id: 'shape:card',
    typeName: 'shape',
    type: 'card',
    parentId: 'page:page',
    index: 'a1',
    x: options.x ?? 0,
    y: options.y ?? 0,
    rotation: 0,
    meta: { elvesChangeSetToken: 'epoch-a:0' },
    props: {
      text,
      attribution: attribution(text, authoredBy ?? 'user'),
      authoredBy,
      comments: options.comments ?? [{ id: 'cmt-base', text: 'base comment' }],
      draftExcluded: options.draftExcluded ?? false,
      custom: { preserved: true },
    },
  }
}

function document(record: DocumentRecord): DocumentRecords {
  return { [record.id]: record }
}

function documentOf(result: CanvasMergeResult): DocumentRecords {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected merge success')
  return result.document
}

function withField(record: DocumentRecord, key: string, value: unknown): DocumentRecord {
  return { ...record, [key]: value }
}

function withoutField(record: DocumentRecord, key: string): DocumentRecord {
  const copy = { ...record }
  delete copy[key]
  return copy
}

test('a one-sided layout tuple change wins', () => {
  const base = document(card())
  const local = document(card({ x: 10 }))

  const merged = documentOf(mergeCanvasRecords({ base, local, remote: base }))

  expect(merged['shape:card']).toMatchObject({ x: 10, y: 0, index: 'a1', rotation: 0 })
})

test('equal concurrent layout tuple changes coalesce', () => {
  const base = document(card())
  const moved = document(card({ x: 10, y: 20 }))

  const merged = documentOf(mergeCanvasRecords({ base, local: moved, remote: moved }))

  expect(merged['shape:card']).toMatchObject({ x: 10, y: 20 })
})

test('unequal concurrent layout tuple changes conflict once at a stable path', () => {
  const base = document(card())
  const local = document(card({ x: 10 }))
  const remote = document(card({ y: 20 }))

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{ kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['layout'] }],
  })
})

test.each([
  ['parentId', 'page:other', 'x', 10],
  ['index', 'a2', 'x', 10],
  ['x', 10, 'y', 20],
  ['y', 20, 'x', 10],
  ['rotation', 1, 'x', 10],
] as const)('layout member %s participates in the atomic tuple', (member, value, other, otherValue) => {
  const baseRecord = card()
  const base = document(baseRecord)
  const local = document(withField(baseRecord, member, value))
  const remote = document(withField(baseRecord, other, otherValue))

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{ kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['layout'] }],
  })
})

test('missing and present layout fields follow the same atomic rules', () => {
  const present = card()
  const missing = withoutField(present, 'rotation')

  const removed = documentOf(mergeCanvasRecords({
    base: document(present), local: document(missing), remote: document(present),
  }))['shape:card']
  expect(Object.hasOwn(removed, 'rotation')).toBe(false)

  expect(mergeCanvasRecords({
    base: document(present),
    local: document(missing),
    remote: document(withField(present, 'x', 10)),
  })).toEqual({
    ok: false,
    conflicts: [{ kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['layout'] }],
  })

  const added = documentOf(mergeCanvasRecords({
    base: document(missing),
    local: document(withField(missing, 'rotation', 1)),
    remote: document(missing),
  }))['shape:card']
  expect(added.rotation).toBe(1)

  expect(mergeCanvasRecords({
    base: document(missing),
    local: document(withField(missing, 'rotation', 1)),
    remote: document(withField(missing, 'x', 10)),
  })).toEqual({
    ok: false,
    conflicts: [{ kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['layout'] }],
  })
})

test('one-sided and equal concurrent card authorship changes win as one value', () => {
  const base = document(card())
  const edited = document(card({ text: 'local edit', authoredBy: 'codex' }))

  expect(documentOf(mergeCanvasRecords({ base, local: edited, remote: base }))['shape:card'].props)
    .toMatchObject({
      text: 'local edit',
      authoredBy: 'codex',
      attribution: attribution('local edit', 'codex'),
    })
  expect(documentOf(mergeCanvasRecords({ base, local: edited, remote: edited }))['shape:card'].props)
    .toMatchObject({
      text: 'local edit',
      authoredBy: 'codex',
      attribution: attribution('local edit', 'codex'),
    })
})

test('unequal concurrent card authorship changes conflict once at a stable path', () => {
  const base = document(card())
  const local = document(card({ text: 'local edit', authoredBy: 'codex' }))
  const remote = document(card({ text: 'remote edit', authoredBy: 'claude' }))

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['props', 'authorship'],
    }],
  })
})

test('disjoint concurrent card authorship-field changes still conflict once', () => {
  const baseRecord = card()
  const baseProps = baseRecord.props as Record<string, unknown>
  const base = document(baseRecord)
  const local = document({ ...baseRecord, props: { ...baseProps, text: 'local edit' } })
  const remote = document({ ...baseRecord, props: { ...baseProps, authoredBy: 'claude' } })

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'atomic-field-conflict', recordId: 'shape:card', path: ['props', 'authorship'],
    }],
  })
})

test('non-card shapes merge authorship-named props generically', () => {
  const cardRecord = card()
  const props = cardRecord.props as Record<string, unknown>
  const question: DocumentRecord = { ...cardRecord, type: 'question', props }
  const local = { ...question, props: { ...props, text: 'local question' } }
  const remote = { ...question, props: { ...props, authoredBy: 'claude' } }

  const merged = documentOf(mergeCanvasRecords({
    base: document(question), local: document(local), remote: document(remote),
  }))['shape:card'].props

  expect(merged).toMatchObject({ text: 'local question', authoredBy: 'claude' })
})

test('a card text change combines with one-sided unrelated props and comments', () => {
  const baseComment = { id: 'cmt-base', text: 'base comment' }
  const remoteComment = { id: 'cmt-remote', text: 'remote comment' }
  const base = document(card({ comments: [baseComment] }))
  const local = document(card({
    text: 'local edit', authoredBy: 'codex', comments: [baseComment],
  }))
  const remote = document(card({
    comments: [baseComment, remoteComment], draftExcluded: true,
  }))

  const merged = documentOf(mergeCanvasRecords({ base, local, remote }))['shape:card']

  expect(merged.props).toMatchObject({
    text: 'local edit',
    authoredBy: 'codex',
    attribution: attribution('local edit', 'codex'),
    comments: [baseComment, remoteComment],
    draftExcluded: true,
    custom: { preserved: true },
  })
  expect(merged.meta).toEqual({ elvesChangeSetToken: 'epoch-a:0' })
})
