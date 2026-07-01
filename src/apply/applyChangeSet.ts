import { Editor } from 'tldraw'
import { ChangeSet, Op } from '../model/changeset'
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

function applyOp(editor: Editor, op: Op): void {
  switch (op.kind) {
    case 'add_comment':
      applyAddComment(editor, op)
      break
    // merge_sources / move_cards added in Task 6
  }
}

export function applyChangeSet(editor: Editor, cs: ChangeSet): void {
  const markId = editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  for (const op of cs.ops) applyOp(editor, op)
  editor.squashToMark(markId)
}
