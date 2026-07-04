import { Editor, createShapeId, TLShapeId } from 'tldraw'
import { ChangeSet, Op, planMerge } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { SectionShape } from '../shapes/SectionShapeUtil'
import { QuestionShape } from '../shapes/QuestionShapeUtil'
import { makeComment, addComment } from '../model/comments'
import { makeNoteCardProps, makeReferenceCardProps, makeFigureCardProps } from '../model/cards'
import { makeSectionProps } from '../model/sections'
import { makeQuestionProps } from '../model/questions'

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

// Each applyX returns the shape ids it TOUCHED — "what the user should see the
// agent just did here" — so applyChangeSet can drive the ephemeral presence glow
// (see src/client/presence.ts). Ids of cards created in the change-set are minted
// locally below, so this return value is the only place they surface.

function applyAddComment(editor: Editor, op: Extract<Op, { kind: 'add_comment' }>): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return []
  const comment = makeComment(newId('cmt'), op.comment.text, op.comment.type)
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: { comments: addComment(shape.props.comments, comment) },
  })
  return [shape.id]
}

function applyMerge(editor: Editor, op: Extract<Op, { kind: 'merge_notes' }>): TLShapeId[] {
  const { representativeId, hiddenIds } = planMerge(op.cardIds)
  for (const id of hiddenIds) {
    const shape = editor.getShape(id as CardShape['id']) as CardShape | undefined
    if (shape && shape.props.kind === 'note') {
      editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { mergedInto: representativeId } })
    }
  }
  // Glow the visible survivor — the hidden members are removed from render.
  return editor.getShape(representativeId as CardShape['id']) ? [representativeId as TLShapeId] : []
}

function applyMove(editor: Editor, op: Extract<Op, { kind: 'move_cards' }>): TLShapeId[] {
  const moved: TLShapeId[] = []
  for (const m of op.moves) {
    const shape = editor.getShape(m.cardId as CardShape['id'])
    if (!shape) continue
    // Claude passes absolute page coords; updateShape expects parent-local coords.
    // getPointInParentSpace is identity for top-level cards, and converts for grouped ones.
    const local = editor.getPointInParentSpace(shape.id, { x: m.x, y: m.y })
    editor.updateShape({ id: shape.id, type: 'card', x: local.x, y: local.y })
    moved.push(shape.id)
  }
  return moved
}

interface Rect { x: number; y: number; w: number; h: number }

/** Gap left below a card we had to slide a new one past. Mirrors the server. */
const PLACEMENT_GAP = 24

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * The placement guard, mirroring server/applyChangeSet.ts: a new card never
 * lands on top of an existing one. Claude picks x (its narrative order) and a y;
 * if that rectangle covers any card we slide it straight DOWN — past the lowest
 * card it hits, plus a gap — keeping x so the card holds its place in the story.
 * In the tab the editor knows each card's REAL measured height, so clearance is
 * exact (the server only sees the understated stored height). Cards created
 * earlier in the same change-set already exist here, so a burst of references
 * stacks cleanly instead of piling on one spot.
 */
function placeClearOf(editor: Editor, x: number, y: number, w: number, h: number): { x: number; y: number } {
  const rects = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'card')
    .map((s) => editor.getShapePageBounds(s.id))
    .filter((b): b is NonNullable<typeof b> => !!b)
    .map((b): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
  const cand: Rect = { x, y, w, h }
  for (let i = 0; i <= rects.length; i++) {
    const hit = rects.filter((r) => overlaps(cand, r))
    if (hit.length === 0) break
    cand.y = Math.max(...hit.map((r) => r.y + r.h)) + PLACEMENT_GAP
  }
  return { x: cand.x, y: cand.y }
}

function applyCreateNoteCard(
  editor: Editor,
  op: Extract<Op, { kind: 'create_note_card' }>,
  author: string,
): TLShapeId[] {
  // Stamp the change-set's author onto the card so its authorship mark shows.
  const props = makeNoteCardProps(op.text, 'transcribed', author)
  const at = placeClearOf(editor, op.x, op.y, props.w, props.h)
  const id = createShapeId()
  editor.createShape<CardShape>({ id, type: 'card', x: at.x, y: at.y, props })
  return [id]
}

function applyCreateReference(editor: Editor, op: Extract<Op, { kind: 'create_reference' }>): TLShapeId[] {
  const props = makeReferenceCardProps(op.reference)
  const at = placeClearOf(editor, op.x, op.y, props.w, props.h)
  const id = createShapeId()
  editor.createShape<CardShape>({ id, type: 'card', x: at.x, y: at.y, props })
  return [id]
}

function applyCreateFigureCard(
  editor: Editor,
  op: Extract<Op, { kind: 'create_figure_card' }>,
  author: string,
): TLShapeId[] {
  // Stamp the change-set's author onto the figure so a Claude-suggested one
  // carries its authorship mark ("its suggestion, my call").
  const props = makeFigureCardProps(op.title, op.description, author)
  const at = placeClearOf(editor, op.x, op.y, props.w, props.h)
  const id = createShapeId()
  editor.createShape<CardShape>({ id, type: 'card', x: at.x, y: at.y, props })
  return [id]
}

function applyCreateSection(editor: Editor, op: Extract<Op, { kind: 'create_section' }>): TLShapeId[] {
  const id = createShapeId()
  editor.createShape<SectionShape>({
    id,
    type: 'section',
    x: op.x,
    y: op.y,
    props: makeSectionProps(op.text, 'claude'),
  })
  return [id]
}

function applyMoveSections(editor: Editor, op: Extract<Op, { kind: 'move_sections' }>): TLShapeId[] {
  const moved: TLShapeId[] = []
  for (const m of op.moves) {
    const shape = editor.getShape(m.sectionId as SectionShape['id'])
    if (shape) {
      editor.updateShape({ id: shape.id, type: 'section', x: m.x, y: m.y })
      moved.push(shape.id)
    }
  }
  return moved
}

function applyEditSectionText(editor: Editor, op: Extract<Op, { kind: 'edit_section_text' }>): TLShapeId[] {
  const shape = editor.getShape(op.sectionId as SectionShape['id']) as SectionShape | undefined
  if (!shape) return []
  editor.updateShape<SectionShape>({
    id: shape.id, type: 'section',
    props: { text: op.text, authoredBy: 'claude' },
  })
  return [shape.id]
}

function applyCreateQuestion(
  editor: Editor,
  op: Extract<Op, { kind: 'create_question' }>,
  author: string,
): TLShapeId[] {
  // Questions drop exactly where Claude asks (like sections) — no overlap slide;
  // an editor's sticky note is meant to sit against the cluster it's about.
  const id = createShapeId()
  editor.createShape<QuestionShape>({
    id,
    type: 'question',
    x: op.x,
    y: op.y,
    props: makeQuestionProps(op.text, author),
  })
  return [id]
}

function applyGroupCards(editor: Editor, op: Extract<Op, { kind: 'group_cards' }>): TLShapeId[] {
  const ids = op.cardIds
    .map((id) => editor.getShape(id as CardShape['id'])?.id)
    .filter((id): id is CardShape['id'] => !!id)
  if (ids.length >= 2) editor.groupShapes(ids)
  // Glow the members the agent bound together (the group wrapper itself is chrome).
  return ids
}

function applyUngroupCards(editor: Editor, op: Extract<Op, { kind: 'ungroup_cards' }>): TLShapeId[] {
  const group = editor.getShape(op.groupId as TLShapeId)
  if (!group) return []
  // Capture the children BEFORE ungrouping — the group wrapper is gone after, so
  // the freed cards are what the user should see light up.
  const children = editor.getSortedChildIdsForParent(group.id)
  editor.ungroupShapes([group.id])
  return [...children]
}

function applySetSummary(editor: Editor, op: Extract<Op, { kind: 'set_summary' }>): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return []
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: {
      summary: op.summary,
      summaryOfHash: op.summaryOfHash,
      summaryBy: op.summaryBy,
      summaryAt: op.summaryAt,
    },
  })
  return [shape.id]
}

function applyOp(editor: Editor, op: Op, author: string): TLShapeId[] {
  switch (op.kind) {
    case 'add_comment':
      return applyAddComment(editor, op)
    case 'merge_notes':
      return applyMerge(editor, op)
    case 'move_cards':
      return applyMove(editor, op)
    case 'create_note_card':
      return applyCreateNoteCard(editor, op, author)
    case 'create_reference':
      return applyCreateReference(editor, op)
    case 'create_figure_card':
      return applyCreateFigureCard(editor, op, author)
    case 'create_section':
      return applyCreateSection(editor, op)
    case 'move_sections':
      return applyMoveSections(editor, op)
    case 'edit_section_text':
      return applyEditSectionText(editor, op)
    case 'create_question':
      return applyCreateQuestion(editor, op, author)
    case 'group_cards':
      return applyGroupCards(editor, op)
    case 'ungroup_cards':
      return applyUngroupCards(editor, op)
    case 'set_summary':
      return applySetSummary(editor, op)
  }
}

/**
 * Apply a change-set to the editor and return the shape ids it touched (deduped),
 * so the caller can glow them as agent presence. The whole change-set is one undo
 * step (mark + squash); the returned ids feed a store OUTSIDE tldraw's document,
 * so presence never enters history.
 */
export function applyChangeSet(editor: Editor, cs: ChangeSet): TLShapeId[] {
  const markId = editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  const affected = new Set<TLShapeId>()
  for (const op of cs.ops) {
    for (const id of applyOp(editor, op, cs.author)) affected.add(id)
  }
  editor.squashToMark(markId)
  return [...affected]
}
