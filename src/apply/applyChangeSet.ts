import { Editor } from 'tldraw'
import { ChangeSet, Op, planMerge } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { makeComment, addComment } from '../model/comments'

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
  }
}

export function applyChangeSet(editor: Editor, cs: ChangeSet): void {
  const markId = editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  for (const op of cs.ops) applyOp(editor, op)
  editor.squashToMark(markId)
}
