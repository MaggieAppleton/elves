import { AnnotationMessage, Comment, CommentType } from './types'

export type AnnotationThreadSource = Pick<Comment, 'id' | 'author' | 'text'> & {
  messages?: AnnotationMessage[]
}

/**
 * Projects a legacy annotation into the thread model without rewriting saved
 * canvases.  The original annotation remains the canonical first Claude turn.
 */
export function threadMessages(annotation: AnnotationThreadSource): AnnotationMessage[] {
  return annotation.messages?.length
    ? annotation.messages
    : [{
        id: `${annotation.id}:initial`,
        author: annotation.author,
        text: annotation.text,
        createdAt: '',
      }]
}

export function commentThread(comment: AnnotationThreadSource): { messages: AnnotationMessage[] } {
  return { messages: threadMessages(comment) }
}

/** Append exactly once, preserving an idempotency key across retrying clients. */
export function appendThreadMessage<T extends AnnotationThreadSource>(
  annotation: T,
  message: AnnotationMessage,
): T {
  if (threadMessages(annotation).some((existing) => existing.id === message.id)) return annotation
  return { ...annotation, messages: [...threadMessages(annotation), message] }
}

export function makeComment(
  id: string,
  text: string,
  type: CommentType | null = null,
  author = 'claude',
  reviewId: string | null = null,
): Comment {
  return {
    id, type, text, resolved: false, author,
    reviewId,
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
}

export function addComment(comments: Comment[], comment: Comment): Comment[] {
  return [...comments, comment]
}

export function resolveComment(comments: Comment[], commentId: string): Comment[] {
  return comments.map((c) => (c.id === commentId ? { ...c, resolved: true } : c))
}

export function visibleComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => !c.resolved)
}

const COMMENT_TOP_GAP = 7
const COMMENT_STACK_GAP = 6
const COMMENT_PADDING_Y = 16
const COMMENT_LINE_H = 19
const COMMENT_TYPE_ROW_H = 24
const APPROX_CHAR_W = 7
const COMMENT_INLINE_CHROME_W = 48

export function estimateCommentHeight(comments: Comment[], cardWidth: number): number {
  const visible = visibleComments(comments)
  if (visible.length === 0) return 0

  const charsPerLine = Math.max(
    12,
    Math.floor((cardWidth - COMMENT_INLINE_CHROME_W) / APPROX_CHAR_W),
  )
  const boxes = visible.map((comment) => {
    const lines = comment.text.split('\n').reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    )
    return COMMENT_PADDING_Y +
      (comment.type ? COMMENT_TYPE_ROW_H : 0) +
      lines * COMMENT_LINE_H
  })

  return COMMENT_TOP_GAP +
    boxes.reduce((sum, height) => sum + height, 0) +
    (boxes.length - 1) * COMMENT_STACK_GAP
}
