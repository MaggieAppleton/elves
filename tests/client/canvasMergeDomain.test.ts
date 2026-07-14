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
