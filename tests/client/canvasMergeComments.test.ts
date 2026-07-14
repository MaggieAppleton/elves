import { expect, test } from 'vitest'
import { estimateCommentHeight, makeComment } from '../../src/model/comments'
import {
  mergeCanvasRecords,
  type CanvasMergeResult,
  type CanvasMergeSource,
  type DocumentRecord,
  type DocumentRecords,
} from '../../src/client/canvasMerge'

function comment(id: string, text = id, extra: Record<string, unknown> = {}) {
  return { ...makeComment(id, text), ...extra }
}

function card(options: {
  comments?: unknown
  w?: number
  commentH?: number
} = {}): DocumentRecord {
  return {
    id: 'shape:card', typeName: 'shape', type: 'card',
    parentId: 'page:page', index: 'a1', x: 0, y: 0, rotation: 0,
    meta: { elvesChangeSetToken: 'epoch-a:0', arbitrary: { keep: true } },
    props: {
      w: options.w ?? 370,
      text: 'card', attribution: [{ author: 'user', length: 4 }], authoredBy: null,
      comments: options.comments ?? [],
      commentH: options.commentH ?? 0,
      custom: { keep: true },
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

function commentsOf(result: CanvasMergeResult): any[] {
  return (documentOf(result)['shape:card'].props as any).comments
}

test('comment merge preserves remote order and appends local-only ids sorted', () => {
  const a = comment('cmt-a')
  const b = comment('cmt-b')
  const shared = comment('cmt-shared')
  const base = document(card({ comments: [a, b] }))
  const local = document(card({ comments: [a, b, comment('cmt-z'), comment('cmt-l'), shared] }))
  const remote = document(card({
    comments: [b, a, comment('cmt-r2'), shared, comment('cmt-r1')],
  }))

  const merged = commentsOf(mergeCanvasRecords({ base, local, remote }))

  expect(merged.map((entry) => entry.id)).toEqual([
    'cmt-b', 'cmt-a', 'cmt-r2', 'cmt-shared', 'cmt-r1', 'cmt-l', 'cmt-z',
  ])
  expect(merged.find((entry) => entry.id === 'cmt-shared')).toEqual(shared)
})

test('unequal same-id comment additions conflict once', () => {
  const base = document(card())
  const local = document(card({ comments: [comment('cmt-new', 'local')] }))
  const remote = document(card({ comments: [comment('cmt-new', 'remote')] }))

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'comment-addition-conflict', recordId: 'shape:card',
      path: ['props', 'comments', 'cmt-new'],
    }],
  })
})

test('comment delete-vs-edit conflicts once', () => {
  const original = comment('cmt-a')
  const base = document(card({ comments: [original] }))
  const local = document(card())
  const remote = document(card({ comments: [{ ...original, resolved: true }] }))

  expect(mergeCanvasRecords({ base, local, remote })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'comment-delete-edit-conflict', recordId: 'shape:card',
      path: ['props', 'comments', 'cmt-a'],
    }],
  })
})

test('concurrent edits to distinct fields of one comment merge generically', () => {
  const original = comment('cmt-a', 'base')
  const base = document(card({ comments: [original] }))
  const local = document(card({ comments: [{ ...original, resolved: true }] }))
  const remote = document(card({ comments: [{ ...original, text: 'remote edit' }] }))

  expect(commentsOf(mergeCanvasRecords({ base, local, remote }))).toEqual([
    { ...original, resolved: true, text: 'remote edit' },
  ])
})

test('unequal text edits return the nested conflict without deriving from a partial comment', () => {
  const original = comment('cmt-a', 'base')
  const base = document(card({ comments: [original] }))
  const local = document(card({ comments: [{ ...original, text: 'local edit' }] }))
  const remote = document(card({ comments: [{ ...original, text: 'remote edit' }] }))

  expect(() => {
    expect(mergeCanvasRecords({ base, local, remote })).toEqual({
      ok: false,
      conflicts: [{
        kind: 'field-value-conflict', recordId: 'shape:card',
        path: ['props', 'comments', 'cmt-a', 'text'],
      }],
    })
  }).not.toThrow()
})

test('a local resolve combines with a remote append', () => {
  const original = comment('cmt-a')
  const appended = comment('cmt-b')
  const base = document(card({ comments: [original] }))
  const local = document(card({ comments: [{ ...original, resolved: true }] }))
  const remote = document(card({ comments: [original, appended] }))

  expect(commentsOf(mergeCanvasRecords({ base, local, remote }))).toEqual([
    { ...original, resolved: true },
    appended,
  ])
})

test('one-sided deletion is accepted and filters the surviving remote order', () => {
  const a = comment('cmt-a')
  const b = comment('cmt-b')
  const c = comment('cmt-c')
  const base = document(card({ comments: [a, b] }))
  const local = document(card({ comments: [b] }))
  const remote = document(card({ comments: [a, b, c] }))

  expect(commentsOf(mergeCanvasRecords({ base, local, remote }))).toEqual([b, c])
})

test.each([
  {
    source: 'base' as const,
    comments: [comment('cmt-a'), comment('cmt-a')],
    path: ['props', 'comments', 'cmt-a'], reason: 'duplicate-id',
  },
  {
    source: 'local' as const,
    comments: [comment('cmt-a'), comment('cmt-a')],
    path: ['props', 'comments', 'cmt-a'], reason: 'duplicate-id',
  },
  {
    source: 'remote' as const,
    comments: [comment('cmt-a'), comment('cmt-a')],
    path: ['props', 'comments', 'cmt-a'], reason: 'duplicate-id',
  },
  {
    source: 'local' as const,
    comments: [{ text: 'missing id' }],
    path: ['props', 'comments', '0', 'id'], reason: 'missing-id',
  },
  {
    source: 'remote' as const,
    comments: [{ id: 42, text: 'numeric id' }],
    path: ['props', 'comments', '0', 'id'], reason: 'non-string-id',
  },
  {
    source: 'local' as const,
    comments: [{ id: 'cmt-a' }],
    path: ['props', 'comments', '0', 'text'], reason: 'missing-text',
  },
  {
    source: 'remote' as const,
    comments: [{ ...comment('cmt-a'), text: 42 }],
    path: ['props', 'comments', '0', 'text'], reason: 'non-string-text',
  },
])('invalid comments in $source return a typed conflict', ({ source, comments, path, reason }) => {
  const empty = document(card())
  const inputs: Record<CanvasMergeSource, DocumentRecords> = {
    base: empty, local: empty, remote: empty,
  }
  inputs[source] = document(card({ comments }))

  expect(mergeCanvasRecords(inputs)).toEqual({
    ok: false,
    conflicts: [{ kind: 'invalid-comment', source, recordId: 'shape:card', path, reason }],
  })
})

test('non-card comments arrays remain generic atomic values', () => {
  const baseCard = card({ comments: [comment('cmt-a')] })
  const question: DocumentRecord = { ...baseCard, type: 'question' }
  const local = { ...question, props: { ...(question.props as any), comments: [comment('cmt-local')] } }
  const remote = { ...question, props: { ...(question.props as any), comments: [comment('cmt-remote')] } }

  expect(mergeCanvasRecords({
    base: document(question), local: document(local), remote: document(remote),
  })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'field-value-conflict', recordId: 'shape:card', path: ['props', 'comments'],
    }],
  })
})

test('commentH ignores divergent inputs and is derived from merged comments and width', () => {
  const short = comment('cmt-a', 'short')
  const long = comment('cmt-b', 'a long comment '.repeat(20))
  const base = document(card({ comments: [short], w: 370, commentH: 10 }))
  const local = document(card({ comments: [short], w: 200, commentH: 111 }))
  const remote = document(card({ comments: [short, long], w: 370, commentH: 222 }))

  const merged = documentOf(mergeCanvasRecords({ base, local, remote }))['shape:card']
  const props = merged.props as any

  expect(props.w).toBe(200)
  expect(props.comments).toEqual([short, long])
  expect(props.commentH).toBe(estimateCommentHeight([short, long], 200))
  expect(props.custom).toEqual({ keep: true })
  expect(merged.meta).toEqual({ elvesChangeSetToken: 'epoch-a:0', arbitrary: { keep: true } })
})

test('equal cards still recompute stale commentH', () => {
  const comments = [comment('cmt-a', 'a visible comment')]
  const stale = document(card({ comments, w: 240, commentH: 999 }))

  const merged = documentOf(mergeCanvasRecords({ base: stale, local: stale, remote: stale }))
  const props = merged['shape:card'].props as any

  expect(props.commentH).toBe(estimateCommentHeight(comments, 240))
})

test.each([
  { label: 'local-only', local: true, remote: false, expectedIds: ['cmt-a', 'cmt-z'] },
  { label: 'remote-only', local: false, remote: true, expectedIds: ['cmt-z', 'cmt-a'] },
  { label: 'equal concurrent', local: true, remote: true, expectedIds: ['cmt-z', 'cmt-a'] },
])('$label card additions validate, order, and derive commentH', ({
  local, remote, expectedIds,
}) => {
  const comments = [comment('cmt-z', 'new card comment'), comment('cmt-a')]
  const added = card({ comments, w: 260, commentH: 999 })
  const result = mergeCanvasRecords({
    base: {},
    local: local ? document(added) : {},
    remote: remote ? document(added) : {},
  })
  const props = documentOf(result)['shape:card'].props as any

  expect(props.commentH).toBe(estimateCommentHeight(comments, 260))
  expect(props.comments.map((entry: any) => entry.id)).toEqual(expectedIds)
})

test('an added card with duplicate comment ids returns a typed source conflict', () => {
  const duplicate = comment('cmt-duplicate')
  const local = document(card({ comments: [duplicate, duplicate] }))

  expect(mergeCanvasRecords({ base: {}, local, remote: {} })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'invalid-comment', source: 'local', recordId: 'shape:card',
      path: ['props', 'comments', 'cmt-duplicate'], reason: 'duplicate-id',
    }],
  })
})
