import { Editor, createShapeId } from 'tldraw'
import { ChangeSet, Op, planMerge } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { SectionShape } from '../shapes/SectionShapeUtil'
import { makeComment, addComment } from '../model/comments'
import { makeSourceCardProps, makeReferenceCardProps } from '../model/cards'
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

function applyMerge(editor: Editor, op: Extract<Op, { kind: 'merge_sources' }>): void {
  const { representativeId, hiddenIds } = planMerge(op.cardIds)
  for (const id of hiddenIds) {
    const shape = editor.getShape(id as CardShape['id']) as CardShape | undefined
    if (shape && shape.props.kind === 'source') {
      editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { mergedInto: representativeId } })
    }
  }
}

function applyMove(editor: Editor, op: Extract<Op, { kind: 'move_cards' }>): void {
  for (const m of op.moves) {
    const shape = editor.getShape(m.cardId as CardShape['id'])
    if (shape) editor.updateShape({ id: shape.id, type: 'card', x: m.x, y: m.y })
  }
}

function applyCreateSourceCard(editor: Editor, op: Extract<Op, { kind: 'create_source_card' }>): void {
  editor.createShape<CardShape>({
    id: createShapeId(),
    type: 'card',
    x: op.x,
    y: op.y,
    props: makeSourceCardProps(op.text, 'transcribed'),
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

function applyOp(editor: Editor, op: Op): void {
  switch (op.kind) {
    case 'add_comment':
      applyAddComment(editor, op)
      break
    case 'merge_sources':
      applyMerge(editor, op)
      break
    case 'move_cards':
      applyMove(editor, op)
      break
    case 'create_source_card':
      applyCreateSourceCard(editor, op)
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
    case 'set_summary':
      applySetSummary(editor, op)
      break
  }
}

export function applyChangeSet(editor: Editor, cs: ChangeSet): void {
  const markId = editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  for (const op of cs.ops) applyOp(editor, op)
  editor.squashToMark(markId)
}
