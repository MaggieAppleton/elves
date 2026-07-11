import { describe, expect, test } from 'vitest'
import type { Editor } from 'tldraw'
import { applyChangeSet } from '../../src/apply/applyChangeSet'
import type { ChangeSet } from '../../src/model/changeset'
import type { Reference } from '../../src/model/types'

/**
 * A minimal fake of the tldraw Editor surface applyChangeSet uses. tldraw's real
 * Editor needs a DOM, but the return-value contract (which ids each op touches,
 * including freshly-minted create ids) is pure logic — this exercises it in node.
 */
function fakeEditor(seed: Array<Record<string, unknown>> = []) {
  const shapes = new Map<string, Record<string, unknown>>()
  for (const s of seed) shapes.set(s.id as string, s)
  const children = new Map<string, string[]>()
  const editor = {
    _shapes: shapes,
    _children: children,
    _grouped: null as string[] | null,
    _ungrouped: null as string[] | null,
    markHistoryStoppingPoint: () => 'mark',
    squashToMark: () => {},
    getShape: (id: string) => shapes.get(id),
    updateShape: (u: { id: string; x?: number; y?: number; props?: Record<string, unknown> }) => {
      const s = shapes.get(u.id)
      if (!s) return
      if (u.x !== undefined) s.x = u.x
      if (u.y !== undefined) s.y = u.y
      if (u.props) s.props = { ...(s.props as object), ...u.props }
    },
    createShape: (s: { id: string; type: string; x: number; y: number; props: unknown }) => {
      shapes.set(s.id, { ...s })
    },
    getPointInParentSpace: (_id: string, p: { x: number; y: number }) => p,
    getCurrentPageShapes: () => [...shapes.values()],
    getShapePageBounds: (id: string) => {
      const s = shapes.get(id) as { x?: number; y?: number; props?: { w?: number; h?: number } } | undefined
      return s ? { x: s.x ?? 0, y: s.y ?? 0, w: s.props?.w ?? 100, h: s.props?.h ?? 50 } : undefined
    },
    groupShapes: (ids: string[]) => { editor._grouped = ids },
    ungroupShapes: (ids: string[]) => { editor._ungrouped = ids },
    getSortedChildIdsForParent: (id: string) => children.get(id) ?? [],
  }
  return editor
}

const cs = (ops: ChangeSet['ops']): ChangeSet => ({ id: 'cs1', author: 'claude', ops })

const noteCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'card', x: 0, y: 0,
  props: { kind: 'note', w: 200, h: 60, comments: [], mergedInto: null, ...extra },
})

const VALID_REF: Reference = {
  url: 'https://example.com', refType: 'link', title: 'Example', authors: [],
  siteName: 'example.com', year: null, venue: null, description: null,
  faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
  fetchedBy: 'claude', fetchedAt: '2026-07-03T00:00:00.000Z',
}

describe('applyChangeSet affected-id contract', () => {
  test('add_comment → [cardId]', () => {
    const ed = fakeEditor([noteCard('card:a')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'add_comment', cardId: 'card:a', comment: { type: null, text: 'hi' } },
    ]))).toEqual(['card:a'])
  })

  test('add_comment on a missing card → []', () => {
    const ed = fakeEditor([])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'add_comment', cardId: 'card:ghost', comment: { type: null, text: 'hi' } },
    ]))).toEqual([])
  })

  test('merge_notes → the visible representative only', () => {
    const ed = fakeEditor([noteCard('card:a'), noteCard('card:b'), noteCard('card:c')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'merge_notes', cardIds: ['card:a', 'card:b', 'card:c'] },
    ]))).toEqual(['card:a'])
    expect((ed._shapes.get('card:b') as any).props.mergedInto).toBe('card:a')
  })

  test('merge_notes with a non-note representative → no merge, nothing affected', () => {
    const prose = { id: 'card:prose', type: 'card', x: 0, y: 0, props: { kind: 'prose', w: 200, h: 60, comments: [], mergedInto: null, text: 'my own words' } }
    const ed = fakeEditor([prose, noteCard('card:b')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'merge_notes', cardIds: ['card:prose', 'card:b'] },
    ]))).toEqual([])
    expect((ed._shapes.get('card:b') as any).props.mergedInto).toBeNull()
    expect((ed._shapes.get('card:prose') as any).props.text).toBe('my own words')
  })

  test('move_cards → the ids actually moved', () => {
    const ed = fakeEditor([noteCard('card:a'), noteCard('card:b')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'move_cards', moves: [
        { cardId: 'card:a', x: 5, y: 5 },
        { cardId: 'card:gone', x: 9, y: 9 },
      ] },
    ]))).toEqual(['card:a'])
  })

  test('create_note_card → the freshly-minted card id', () => {
    const ed = fakeEditor([])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'create_note_card', text: 'transcribed', x: 0, y: 0 },
    ]))
    expect(ids).toHaveLength(1)
    expect(ed._shapes.get(ids[0]!)).toBeDefined()
    expect((ed._shapes.get(ids[0]!) as any).type).toBe('card')
  })

  test('create_reference → the freshly-minted card id', () => {
    const ed = fakeEditor([])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'create_reference', reference: VALID_REF, x: 0, y: 0 },
    ]))
    expect(ids).toHaveLength(1)
    expect(ed._shapes.get(ids[0]!)).toBeDefined()
  })

  test('create_figure_card → a freshly-minted figure card stamped with the author', () => {
    const ed = fakeEditor([])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'create_figure_card', title: 'Spectrum', description: 'rigid → malleable axis', x: 0, y: 0 },
    ]))
    expect(ids).toHaveLength(1)
    const shape = ed._shapes.get(ids[0]!) as any
    expect(shape.type).toBe('card')
    expect(shape.props.kind).toBe('figure')
    expect(shape.props.figureTitle).toBe('Spectrum')
    expect(shape.props.text).toBe('rigid → malleable axis') // description lives in text
    expect(shape.props.figureStatus).toBe('idea')
    expect(shape.props.authoredBy).toBe('claude') // its suggestion, my call
  })

  test('create_section → the freshly-minted section id', () => {
    const ed = fakeEditor([])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'create_section', text: 'Theme', x: 0, y: 0 },
    ]))
    expect(ids).toHaveLength(1)
    expect((ed._shapes.get(ids[0]!) as any).type).toBe('section')
  })

  test('move_sections + edit_section_text → the section ids', () => {
    const ed = fakeEditor([{ id: 'shape:s1', type: 'section', x: 0, y: 0, props: { text: 'T' } }])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'move_sections', moves: [{ sectionId: 'shape:s1', x: 3, y: 3 }] },
    ]))).toEqual(['shape:s1'])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'edit_section_text', sectionId: 'shape:s1', text: 'New' },
    ]))).toEqual(['shape:s1'])
  })

  test('create_question → the freshly-minted question id, stamped with the author', () => {
    const ed = fakeEditor([])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'create_question', text: 'What did it cost her?', x: 4, y: 5 },
    ]))
    expect(ids).toHaveLength(1)
    const shape = ed._shapes.get(ids[0]!) as any
    expect(shape.type).toBe('question')
    expect(shape.props.text).toBe('What did it cost her?')
    expect(shape.props.authoredBy).toBe('claude') // the change-set author
    expect(shape.props.dismissed).toBe(false)
  })

  test('group_cards → the member ids', () => {
    const ed = fakeEditor([noteCard('card:a'), noteCard('card:b')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'group_cards', cardIds: ['card:a', 'card:b'] },
    ]))).toEqual(['card:a', 'card:b'])
  })

  test('ungroup_cards → the pre-ungroup children', () => {
    const ed = fakeEditor([{ id: 'shape:g1', type: 'group', x: 0, y: 0, props: {} }])
    ed._children.set('shape:g1', ['card:a', 'card:b'])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'ungroup_cards', groupId: 'shape:g1' },
    ]))).toEqual(['card:a', 'card:b'])
    expect(ed._ungrouped).toEqual(['shape:g1'])
  })

  test('edit_card updates a note card\'s text — notes are working material', () => {
    const ed = fakeEditor([noteCard('card:a', { noteKind: 'text', text: 'old body' })])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'edit_card', cardId: 'card:a', text: 'new body' },
    ]))).toEqual(['card:a'])
    expect((ed._shapes.get('card:a') as any).props.text).toBe('new body')
  })

  test('edit_card REFUSES to touch a reference card\'s annotation — that stays the user\'s alone', () => {
    const ed = fakeEditor([noteCard('card:ref', { noteKind: 'reference', text: 'my own annotation' })])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'edit_card', cardId: 'card:ref', text: 'agent trying to rewrite the annotation' },
    ]))).toEqual([])
    expect((ed._shapes.get('card:ref') as any).props.text).toBe('my own annotation')
  })

  test('set_summary → [cardId]', () => {
    const ed = fakeEditor([noteCard('card:a')])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'set_summary', cardId: 'card:a', summary: 's', summaryOfHash: 'h', summaryBy: 'ollama', summaryAt: 't' },
    ]))).toEqual(['card:a'])
  })

  test('set_comment_summary → [cardId], writing the summary onto the matching comment only', () => {
    const ed = fakeEditor([noteCard('card:a', {
      comments: [
        { id: 'cmt-1', type: null, text: 'first', resolved: false, author: 'claude', summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
        { id: 'cmt-2', type: null, text: 'second', resolved: false, author: 'claude', summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
      ],
    })])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'set_comment_summary', cardId: 'card:a', commentId: 'cmt-1', summary: 's', summaryOfHash: 'h', summaryBy: 'ollama', summaryAt: 't' },
    ]))).toEqual(['card:a'])
    const comments = (ed._shapes.get('card:a') as any).props.comments
    expect(comments.find((c: any) => c.id === 'cmt-1')).toMatchObject({ summary: 's', summaryOfHash: 'h', summaryBy: 'ollama', summaryAt: 't' })
    expect(comments.find((c: any) => c.id === 'cmt-2')).toMatchObject({ summary: null })
  })

  test('set_comment_summary on a missing card → []', () => {
    const ed = fakeEditor([])
    expect(applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'set_comment_summary', cardId: 'card:ghost', commentId: 'cmt-1', summary: 's', summaryOfHash: 'h', summaryBy: 'ollama', summaryAt: 't' },
    ]))).toEqual([])
  })

  test('multi-op change-set unions and dedupes affected ids', () => {
    const ed = fakeEditor([noteCard('card:a'), noteCard('card:b')])
    const ids = applyChangeSet(ed as unknown as Editor, cs([
      { kind: 'add_comment', cardId: 'card:a', comment: { type: null, text: 'x' } },
      { kind: 'move_cards', moves: [{ cardId: 'card:a', x: 1, y: 1 }, { cardId: 'card:b', x: 2, y: 2 }] },
    ]))
    expect(new Set(ids)).toEqual(new Set(['card:a', 'card:b']))
    expect(ids).toHaveLength(2) // deduped: card:a touched twice
  })
})
