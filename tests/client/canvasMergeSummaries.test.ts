import { expect, test } from 'vitest'
import { mergeCanvasRecords, type DocumentRecord, type DocumentRecords } from '../../src/client/canvasMerge'
import { makeComment } from '../../src/model/comments'
import { summaryHash } from '../../src/model/summary'

type ShapeKind = 'card' | 'question'

const NULL_SUMMARY = {
  summary: null,
  summaryOfHash: null,
  summaryBy: null,
  summaryAt: null,
}

function summaryFor(text: string, label: string) {
  return {
    summary: `${label} gist`,
    summaryOfHash: summaryHash(text),
    summaryBy: `${label}/model`,
    summaryAt: `${label}-time`,
  }
}

function comment(id: string, text: string, summary: Record<string, unknown> = NULL_SUMMARY) {
  return { ...makeComment(id, text), ...summary }
}

function shape(
  kind: ShapeKind,
  text: string,
  summary: Record<string, unknown> = {},
  comments: unknown[] = [],
): DocumentRecord {
  const props = kind === 'card'
    ? {
        w: 300, text, attribution: [{ author: 'user', length: text.length }], authoredBy: null,
        comments, commentH: 0, ...summary,
      }
    : { w: 240, h: 96, text, authoredBy: null, dismissed: false, ...summary }
  return {
    id: `shape:${kind}`, typeName: 'shape', type: kind,
    parentId: 'page:page', index: kind === 'card' ? 'a1' : 'a2',
    x: 0, y: 0, rotation: 0, props,
  }
}

function records(...items: DocumentRecord[]): DocumentRecords {
  return Object.fromEntries(items.map((item) => [item.id, item]))
}

function mergedDocument(input: {
  base: DocumentRecords
  local: DocumentRecords
  remote: DocumentRecords
}): DocumentRecords {
  const result = mergeCanvasRecords(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected successful merge')
  return result.document
}

function propsOf(document: DocumentRecords, kind: ShapeKind): any {
  return document[`shape:${kind}`].props
}

function expectCleared(value: Record<string, unknown>): void {
  expect(value).toMatchObject(NULL_SUMMARY)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

test.each([
  { kind: 'card' as const, mode: 'one-sided' as const },
  { kind: 'card' as const, mode: 'equal' as const },
  { kind: 'question' as const, mode: 'one-sided' as const },
  { kind: 'question' as const, mode: 'equal' as const },
])('$mode $kind props summary changes coalesce atomically', ({ kind, mode }) => {
  const text = `${kind} text`
  const baseRecord = shape(kind, text, NULL_SUMMARY)
  const changed = shape(kind, text, summaryFor(text, 'next'))
  const document = mergedDocument({
    base: records(baseRecord),
    local: records(changed),
    remote: records(mode === 'equal' ? changed : baseRecord),
  })

  expect(propsOf(document, kind)).toMatchObject(summaryFor(text, 'next'))
})

test.each(['card', 'question'] as const)(
  'disjoint concurrent %s props summary changes conflict once',
  (kind) => {
    const text = `${kind} text`
    const base = shape(kind, text, NULL_SUMMARY)
    const local = shape(kind, text, { ...NULL_SUMMARY, summary: 'local gist' })
    const remote = shape(kind, text, { ...NULL_SUMMARY, summaryBy: 'remote/model' })

    expect(mergeCanvasRecords({
      base: records(base), local: records(local), remote: records(remote),
    })).toEqual({
      ok: false,
      conflicts: [{
        kind: 'atomic-field-conflict', recordId: `shape:${kind}`,
        path: ['props', 'summary'],
      }],
    })
  },
)

test.each(['one-sided', 'equal'] as const)(
  '%s card comment summary changes coalesce atomically',
  (mode) => {
    const text = 'comment text'
    const baseComment = comment('cmt-a', text)
    const changed = comment('cmt-a', text, summaryFor(text, 'next'))
    const base = shape('card', 'card text', {}, [baseComment])
    const local = shape('card', 'card text', {}, [changed])
    const remote = shape('card', 'card text', {}, [mode === 'equal' ? changed : baseComment])

    const document = mergedDocument({
      base: records(base), local: records(local), remote: records(remote),
    })

    expect(propsOf(document, 'card').comments[0]).toMatchObject(summaryFor(text, 'next'))
  },
)

test('disjoint concurrent card comment summary changes conflict once', () => {
  const baseComment = comment('cmt-a', 'comment text')
  const localComment = { ...baseComment, summary: 'local gist' }
  const remoteComment = { ...baseComment, summaryBy: 'remote/model' }

  expect(mergeCanvasRecords({
    base: records(shape('card', 'card text', {}, [baseComment])),
    local: records(shape('card', 'card text', {}, [localComment])),
    remote: records(shape('card', 'card text', {}, [remoteComment])),
  })).toEqual({
    ok: false,
    conflicts: [{
      kind: 'atomic-field-conflict', recordId: 'shape:card',
      path: ['props', 'comments', 'cmt-a', 'summary'],
    }],
  })
})

test('existing one-sided card text changes clear a stale summary quartet', () => {
  const base = shape('card', 'base text', summaryFor('base text', 'base'))
  const local = shape('card', 'local text', summaryFor('base text', 'base'))
  const document = mergedDocument({
    base: records(base), local: records(local), remote: records(base),
  })

  expectCleared(propsOf(document, 'card'))
})

test('existing equal question text changes clear a stale summary quartet', () => {
  const base = shape('question', 'base text', summaryFor('base text', 'base'))
  const changed = shape('question', 'changed text', summaryFor('base text', 'base'))
  const document = mergedDocument({
    base: records(base), local: records(changed), remote: records(changed),
  })

  expectCleared(propsOf(document, 'question'))
})

test.each(['card', 'question'] as const)(
  'independently merged %s text and remote summary are invalidated together',
  (kind) => {
    const base = shape(kind, 'base text', summaryFor('base text', 'base'))
    const local = shape(kind, 'local text', summaryFor('base text', 'base'))
    const remote = shape(kind, 'base text', summaryFor('base text', 'remote'))
    const document = mergedDocument({
      base: records(base), local: records(local), remote: records(remote),
    })

    expect(propsOf(document, kind).text).toBe('local text')
    expectCleared(propsOf(document, kind))
  },
)

test('independently merged comment text and remote summary are invalidated together', () => {
  const baseComment = comment('cmt-a', 'base text', summaryFor('base text', 'base'))
  const localComment = { ...baseComment, text: 'local text' }
  const remoteComment = comment('cmt-a', 'base text', summaryFor('base text', 'remote'))
  const document = mergedDocument({
    base: records(shape('card', 'card text', {}, [baseComment])),
    local: records(shape('card', 'card text', {}, [localComment])),
    remote: records(shape('card', 'card text', {}, [remoteComment])),
  })
  const mergedComment = propsOf(document, 'card').comments[0]

  expect(mergedComment.text).toBe('local text')
  expectCleared(mergedComment)
})

test.each([
  { mode: 'local-only', local: true, remote: false },
  { mode: 'remote-only', local: false, remote: true },
  { mode: 'equal', local: true, remote: true },
])('$mode additions clear stale card, question, and comment summaries', ({ local, remote }) => {
  const staleComment = comment('cmt-a', 'comment text', summaryFor('other comment', 'stale'))
  const card = shape('card', 'card text', summaryFor('other card', 'stale'), [staleComment])
  const question = shape('question', 'question text', summaryFor('other question', 'stale'))
  const added = records(card, question)
  const document = mergedDocument({
    base: {}, local: local ? added : {}, remote: remote ? added : {},
  })

  expectCleared(propsOf(document, 'card'))
  expectCleared(propsOf(document, 'question'))
  expectCleared(propsOf(document, 'card').comments[0])
})

test('matching hashes without complete quartets clear on card, question, and comment', () => {
  const cardText = 'card text'
  const questionText = 'question text'
  const commentText = 'comment text'
  const partialComment = {
    id: 'cmt-a', type: null, text: commentText, resolved: false, author: 'claude', reviewId: null,
    summaryOfHash: summaryHash(commentText),
  }
  const card = shape('card', cardText, { summaryOfHash: summaryHash(cardText) }, [partialComment])
  const question = shape('question', questionText, {
    summaryOfHash: summaryHash(questionText),
  })
  const unchanged = records(card, question)
  const document = mergedDocument({ base: unchanged, local: unchanged, remote: unchanged })

  expect.soft(propsOf(document, 'card')).toMatchObject(NULL_SUMMARY)
  expect.soft(propsOf(document, 'question')).toMatchObject(NULL_SUMMARY)
  expect.soft(propsOf(document, 'card').comments[0]).toMatchObject(NULL_SUMMARY)
})

test('matching card, question, and comment summary quartets survive', () => {
  const matchingComment = comment('cmt-a', 'comment text', summaryFor('comment text', 'comment'))
  const card = shape('card', 'card text', summaryFor('card text', 'card'), [matchingComment])
  const question = shape('question', 'question text', summaryFor('question text', 'question'))
  const unchanged = records(card, question)
  const document = mergedDocument({ base: unchanged, local: unchanged, remote: unchanged })

  expect(propsOf(document, 'card')).toMatchObject(summaryFor('card text', 'card'))
  expect(propsOf(document, 'question')).toMatchObject(summaryFor('question text', 'question'))
  expect(propsOf(document, 'card').comments[0]).toMatchObject(
    summaryFor('comment text', 'comment'),
  )
})

test('records without summary quartet fields stay unchanged', () => {
  const card: DocumentRecord = {
    id: 'shape:card', typeName: 'shape', type: 'card', props: { custom: { keep: true } },
  }
  const question = shape('question', 'plain question')
  const unchanged = records(card, question)

  expect(mergedDocument({ base: unchanged, local: unchanged, remote: unchanged })).toEqual(unchanged)
})

test('summary finalization never mutates frozen inputs', () => {
  const added = records(shape('card', 'card text', summaryFor('old text', 'stale')))
  const input = deepFreeze({ base: {}, local: added, remote: {} })
  const before = JSON.parse(JSON.stringify(input))

  const document = mergedDocument(input)

  expect(input).toEqual(before)
  expectCleared(propsOf(document, 'card'))
})
