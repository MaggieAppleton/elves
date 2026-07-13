import { describe, expect, test } from 'vitest'
import type { ChangeSet, Op } from '../../src/model/changeset'
import {
  changeSetDigest,
  semanticChangeSet,
  semanticChangeSetJson,
  validateChangeSetBounds,
} from '../../server/changeSetIdentity'

const reference = {
  url: 'https://example.com', refType: 'link' as const, title: 'Example', authors: ['A', 'B'],
  siteName: 'Example', year: 2026, venue: 'Venue', description: 'Description',
  faviconAssetId: 'favicon', thumbnailAssetId: 'thumbnail', doi: 'doi', arxivId: 'arxiv',
  fetchedBy: 'claude' as const, fetchedAt: 'T',
}

// Compile-time exhaustiveness: a new Op kind must add a semantic identity fixture.
const ALL_OPS: { [Kind in Op['kind']]: Extract<Op, { kind: Kind }> } = {
  add_comment: {
    kind: 'add_comment', cardId: 'card-a',
    comment: { type: 'counterpoint', text: 'Comment', reviewId: 'review-a' },
  },
  merge_notes: { kind: 'merge_notes', cardIds: ['card-a', 'card-b'] },
  move_cards: {
    kind: 'move_cards',
    moves: [{ cardId: 'card-a', x: 1, y: 2 }, { cardId: 'card-b', x: 3, y: 4 }],
  },
  create_note_card: { kind: 'create_note_card', text: 'Note', x: 1, y: 2 },
  create_reference: { kind: 'create_reference', reference, x: 1, y: 2 },
  create_section: { kind: 'create_section', text: 'Section', x: 1, y: 2 },
  create_figure_card: {
    kind: 'create_figure_card', title: 'Figure', description: 'Description', x: 1, y: 2,
  },
  edit_card: { kind: 'edit_card', cardId: 'card-a', text: 'Text', title: 'Title' },
  delete_card: { kind: 'delete_card', cardId: 'card-a' },
  move_sections: {
    kind: 'move_sections',
    moves: [{ sectionId: 'section-a', x: 1, y: 2 }, { sectionId: 'section-b', x: 3, y: 4 }],
  },
  edit_section_text: { kind: 'edit_section_text', sectionId: 'section-a', text: 'Section' },
  create_question: { kind: 'create_question', text: 'Question?', x: 1, y: 2 },
  group_cards: { kind: 'group_cards', cardIds: ['card-a', 'card-b'] },
  ungroup_cards: { kind: 'ungroup_cards', groupId: 'group-a' },
  set_summary: {
    kind: 'set_summary', cardId: 'card-a', summary: 'Summary', summaryOfHash: 'hash',
    summaryBy: 'model', summaryAt: 'T',
  },
  set_comment_summary: {
    kind: 'set_comment_summary', cardId: 'card-a', commentId: 'comment-a', summary: 'Summary',
    summaryOfHash: 'hash', summaryBy: 'model', summaryAt: 'T',
  },
  set_question_summary: {
    kind: 'set_question_summary', questionId: 'question-a', summary: 'Summary',
    summaryOfHash: 'hash', summaryBy: 'model', summaryAt: 'T',
  },
}

type Path = Array<string | number>

function leafPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      key === 'kind' ? [] : leafPaths(entry, [...path, key]))
  }
  return [path]
}

function replacementFor(value: unknown, path: Path): unknown {
  const key = path.at(-1)
  if (key === 'type') return 'needs-evidence'
  if (key === 'refType') return 'article'
  if (key === 'fetchedBy') return 'user'
  if (typeof value === 'string') return `${value}-changed`
  if (typeof value === 'number') return value + 1
  if (value === null) return 'now-present'
  throw new Error(`unsupported leaf ${path.join('.')}`)
}

function mutateLeaf<T>(value: T, path: Path): T {
  const changed = structuredClone(value)
  let cursor: any = changed
  for (const segment of path.slice(0, -1)) cursor = cursor[segment]
  const key = path.at(-1)!
  cursor[key] = replacementFor(cursor[key], path)
  return changed
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reversedKeys(entry)]),
  )
}

function changeSet(op: Op, over: Partial<ChangeSet> = {}): ChangeSet {
  return { id: 'change-a', author: 'claude', ops: [op], ...over }
}

describe('semantic change-set identity', () => {
  test('explicitly projects every operation kind', () => {
    for (const [kind, op] of Object.entries(ALL_OPS)) {
      const projected = semanticChangeSet(changeSet(op))
      expect(projected.ops[0].kind, kind).toBe(kind)
    }
  })

  test('every semantic leaf of every operation kind changes the digest', () => {
    for (const [kind, op] of Object.entries(ALL_OPS)) {
      const baseline = changeSetDigest(changeSet(op))
      for (const path of leafPaths(op)) {
        const changed = mutateLeaf(op, path)
        expect(
          changeSetDigest(changeSet(changed)),
          `${kind}.${path.join('.')} must affect identity`,
        ).not.toBe(baseline)
      }
    }
  })

  test('ordered semantic arrays and operation order change the digest', () => {
    const complete: ChangeSet = { id: 'complete', author: 'claude', ops: Object.values(ALL_OPS) }
    const baseline = changeSetDigest(complete)
    const mutations: Array<[string, (value: ChangeSet) => void]> = [
      ['operations', (value) => value.ops.reverse()],
      ['reference authors', (value) => {
        const op = value.ops.find((entry) => entry.kind === 'create_reference')
        if (op?.kind === 'create_reference') op.reference.authors.reverse()
      }],
      ['merge ids', (value) => {
        const op = value.ops.find((entry) => entry.kind === 'merge_notes')
        if (op?.kind === 'merge_notes') op.cardIds.reverse()
      }],
      ['group ids', (value) => {
        const op = value.ops.find((entry) => entry.kind === 'group_cards')
        if (op?.kind === 'group_cards') op.cardIds.reverse()
      }],
      ['card moves', (value) => {
        const op = value.ops.find((entry) => entry.kind === 'move_cards')
        if (op?.kind === 'move_cards') op.moves.reverse()
      }],
      ['section moves', (value) => {
        const op = value.ops.find((entry) => entry.kind === 'move_sections')
        if (op?.kind === 'move_sections') op.moves.reverse()
      }],
    ]
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(complete)
      mutate(changed)
      expect(changeSetDigest(changed), label).not.toBe(baseline)
    }
  })

  test('operation kind, change-set id, and author are identity-bearing', () => {
    expect(changeSetDigest(changeSet(ALL_OPS.create_note_card)))
      .not.toBe(changeSetDigest(changeSet(ALL_OPS.create_section)))
    expect(changeSetDigest(changeSet(ALL_OPS.merge_notes)))
      .not.toBe(changeSetDigest(changeSet(ALL_OPS.group_cards)))
    expect(changeSetDigest(changeSet(ALL_OPS.delete_card, { id: 'change-a' })))
      .not.toBe(changeSetDigest(changeSet(ALL_OPS.delete_card, { id: 'change-b' })))
    expect(changeSetDigest(changeSet(ALL_OPS.delete_card, { author: 'claude' })))
      .not.toBe(changeSetDigest(changeSet(ALL_OPS.delete_card, { author: 'openai' })))
  })

  test('object key order is canonical and unknown extras do not enter identity', () => {
    const plain = changeSet(ALL_OPS.create_reference)
    const reordered = reversedKeys(plain) as ChangeSet
    const withExtras = structuredClone(plain) as ChangeSet & Record<string, unknown>
    withExtras.noise = { summary: 'not semantic' }
    ;(withExtras.ops[0] as Op & Record<string, unknown>).noise = 'not semantic'
    expect(changeSetDigest(reordered)).toBe(changeSetDigest(plain))
    expect(changeSetDigest(withExtras)).toBe(changeSetDigest(plain))
  })

  test('undefined and null reviewId have the same semantic identity', () => {
    const omitted = structuredClone(ALL_OPS.add_comment)
    omitted.comment.reviewId = undefined
    const explicitNull = structuredClone(ALL_OPS.add_comment)
    explicitNull.comment.reviewId = null
    expect(changeSetDigest(changeSet(omitted))).toBe(changeSetDigest(changeSet(explicitNull)))
    expect(semanticChangeSet(changeSet(omitted)).ops[0]).toEqual(explicitNull)
  })

  test('canonical JSON and digest are stable across calls', () => {
    const input = changeSet(ALL_OPS.create_reference)
    const json = semanticChangeSetJson(input)
    expect(semanticChangeSetJson(input)).toBe(json)
    expect(changeSetDigest(input)).toMatch(/^[a-f0-9]{64}$/)
    expect(changeSetDigest(input)).toBe(changeSetDigest(input))
  })
})

describe('semantic change-set bounds', () => {
  test('allows 512 operations and rejects 513', () => {
    const op = ALL_OPS.delete_card
    expect(validateChangeSetBounds({ id: 'x', author: 'claude', ops: Array(512).fill(op) }))
      .toEqual({ ok: true })
    expect(validateChangeSetBounds({ id: 'x', author: 'claude', ops: Array(513).fill(op) }))
      .toEqual({ ok: false, code: 'too-many-ops' })
  })

  test('allows 2,048 array entries and rejects 2,049', () => {
    const ids = Array.from({ length: 2_048 }, (_, index) => `card-${index}`)
    expect(validateChangeSetBounds(changeSet({ kind: 'merge_notes', cardIds: ids })))
      .toEqual({ ok: true })
    expect(validateChangeSetBounds(changeSet({ kind: 'merge_notes', cardIds: [...ids, 'overflow'] })))
      .toEqual({ ok: false, code: 'array-too-large' })
  })

  test('rejects every oversized semantic array before projection can copy it', () => {
    const unreadableOversizedArray = <T>(): T[] => new Proxy(new Array<T>(2_049), {
      get(target, property, receiver) {
        if (property === 'map' || property === Symbol.iterator || /^\d+$/.test(String(property))) {
          throw new Error('oversized array was traversed')
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const cases: ChangeSet[] = [
      changeSet({ kind: 'merge_notes', cardIds: unreadableOversizedArray<string>() }),
      changeSet({
        kind: 'move_cards',
        moves: unreadableOversizedArray<{ cardId: string; x: number; y: number }>(),
      }),
      changeSet({
        kind: 'create_reference',
        reference: { ...reference, authors: unreadableOversizedArray<string>() },
        x: 1,
        y: 2,
      }),
    ]
    for (const input of cases) {
      expect(() => validateChangeSetBounds(input)).not.toThrow()
      expect(validateChangeSetBounds(input)).toEqual({ ok: false, code: 'array-too-large' })
    }
  })

  test('oversized unknown extras do not affect semantic bounds', () => {
    const input = changeSet(ALL_OPS.delete_card) as ChangeSet & Record<string, unknown>
    input.unknown = new Array(2_049)
    ;(input.ops[0] as Op & Record<string, unknown>).unknown = new Array(2_049)
    expect(validateChangeSetBounds(input)).toEqual({ ok: true })
  })

  test('allows semantic depth 16 and rejects depth 17', () => {
    const nested = (levels: number): unknown => {
      let value: unknown = 'leaf'
      for (let index = 0; index < levels; index++) value = [value]
      return value
    }
    const withText = (levels: number) => changeSet({
      kind: 'create_note_card', text: nested(levels) as string, x: 1, y: 2,
    })
    expect(validateChangeSetBounds(withText(12))).toEqual({ ok: true })
    expect(validateChangeSetBounds(withText(13))).toEqual({ ok: false, code: 'too-deep' })
  })

  test('allows exactly 1,000,000 semantic bytes and rejects one byte more', () => {
    const base = changeSet({ kind: 'create_note_card', text: '', x: 1, y: 2 })
    const overhead = Buffer.byteLength(semanticChangeSetJson(base), 'utf8')
    const exact = changeSet({
      kind: 'create_note_card', text: 'x'.repeat(1_000_000 - overhead), x: 1, y: 2,
    })
    const tooLarge = changeSet({
      kind: 'create_note_card', text: 'x'.repeat(1_000_001 - overhead), x: 1, y: 2,
    })
    expect(Buffer.byteLength(semanticChangeSetJson(exact), 'utf8')).toBe(1_000_000)
    expect(validateChangeSetBounds(exact)).toEqual({ ok: true })
    expect(validateChangeSetBounds(tooLarge)).toEqual({ ok: false, code: 'too-large' })
  })
})
