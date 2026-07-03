import { Editor, createShapeId, TLShapeId } from 'tldraw'
import { ChangeSet, Op, planMerge } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { SectionShape } from '../shapes/SectionShapeUtil'
import { makeComment, addComment } from '../model/comments'
import { makeNoteCardProps, makeReferenceCardProps } from '../model/cards'
import { makeSectionProps } from '../model/sections'

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function applyAddComment(editor: Editor, op: Extract<Op, { kind: 'add_comment' }>): void {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return
  const comment = makeComment(newId('cmt'), op.comment.text, op.comment.type)
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: { comments: addComment(shape.props.comments, comment) },
  })
}

function applyMerge(editor: Editor, op: Extract<Op, { kind: 'merge_notes' }>): void {
  const { representativeId, hiddenIds } = planMerge(op.cardIds)
  for (const id of hiddenIds) {
    const shape = editor.getShape(id as CardShape['id']) as CardShape | undefined
    if (shape && shape.props.kind === 'note') {
      editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { mergedInto: representativeId } })
    }
  }
}

function applyMove(editor: Editor, op: Extract<Op, { kind: 'move_cards' }>): void {
  for (const m of op.moves) {
    const shape = editor.getShape(m.cardId as CardShape['id'])
    if (!shape) continue
    // Claude passes absolute page coords; updateShape expects parent-local coords.
    // getPointInParentSpace is identity for top-level cards, and converts for grouped ones.
    const local = editor.getPointInParentSpace(shape.id, { x: m.x, y: m.y })
    editor.updateShape({ id: shape.id, type: 'card', x: local.x, y: local.y })
  }
}

function applyCreateNoteCard(
  editor: Editor,
  op: Extract<Op, { kind: 'create_note_card' }>,
  author: string,
): void {
  editor.createShape<CardShape>({
    id: createShapeId(),
    type: 'card',
    x: op.x,
    y: op.y,
    // Stamp the change-set's author onto the card so its authorship mark shows.
    props: makeNoteCardProps(op.text, 'transcribed', author),
  })
}

function applyCreateReference(editor: Editor, op: Extract<Op, { kind: 'create_reference' }>): void {
  editor.createShape<CardShape>({
    id: createShapeId(),
    type: 'card',
    x: op.x,
    y: op.y,
    props: makeReferenceCardProps(op.reference),
  })
}

function applyCreateSection(editor: Editor, op: Extract<Op, { kind: 'create_section' }>): void {
  editor.createShape<SectionShape>({
    id: createShapeId(),
    type: 'section',
    x: op.x,
    y: op.y,
    props: makeSectionProps(op.text, 'claude'),
  })
}

function applyMoveSections(editor: Editor, op: Extract<Op, { kind: 'move_sections' }>): void {
  for (const m of op.moves) {
    const shape = editor.getShape(m.sectionId as SectionShape['id'])
    if (shape) editor.updateShape({ id: shape.id, type: 'section', x: m.x, y: m.y })
  }
}

function applyEditSectionText(editor: Editor, op: Extract<Op, { kind: 'edit_section_text' }>): void {
  const shape = editor.getShape(op.sectionId as SectionShape['id']) as SectionShape | undefined
  if (!shape) return
  editor.updateShape<SectionShape>({
    id: shape.id, type: 'section',
    props: { text: op.text, authoredBy: 'claude' },
  })
}

function applyGroupCards(editor: Editor, op: Extract<Op, { kind: 'group_cards' }>): void {
  const ids = op.cardIds
    .map((id) => editor.getShape(id as CardShape['id'])?.id)
    .filter((id): id is CardShape['id'] => !!id)
  if (ids.length >= 2) editor.groupShapes(ids)
}

function applyUngroupCards(editor: Editor, op: Extract<Op, { kind: 'ungroup_cards' }>): void {
  const group = editor.getShape(op.groupId as TLShapeId)
  if (group) editor.ungroupShapes([group.id])
}

function applySetSummary(editor: Editor, op: Extract<Op, { kind: 'set_summary' }>): void {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: {
      summary: op.summary,
      summaryOfHash: op.summaryOfHash,
      summaryBy: op.summaryBy,
      summaryAt: op.summaryAt,
    },
  })
}

function applyOp(editor: Editor, op: Op, author: string): void {
  switch (op.kind) {
    case 'add_comment':
      applyAddComment(editor, op)
      break
    case 'merge_notes':
      applyMerge(editor, op)
      break
    case 'move_cards':
      applyMove(editor, op)
      break
    case 'create_note_card':
      applyCreateNoteCard(editor, op, author)
      break
    case 'create_reference':
      applyCreateReference(editor, op)
      break
    case 'create_section':
      applyCreateSection(editor, op)
      break
    case 'move_sections':
      applyMoveSections(editor, op)
      break
    case 'edit_section_text':
      applyEditSectionText(editor, op)
      break
    case 'group_cards':
      applyGroupCards(editor, op)
      break
    case 'ungroup_cards':
      applyUngroupCards(editor, op)
      break
    case 'set_summary':
      applySetSummary(editor, op)
      break
  }
}

export function applyChangeSet(editor: Editor, cs: ChangeSet): void {
  const markId = editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  for (const op of cs.ops) applyOp(editor, op, cs.author)
  editor.squashToMark(markId)
}
