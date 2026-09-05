import type { Editor, TLShapeId } from 'tldraw'
import type { AnnotationTarget } from './annotationSelection'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'

export type AnnotationCueAnchor = {
  left: number
  top: number
  side: 'left' | 'right'
}

function stableIdentity(value: unknown): string {
  return JSON.stringify(value)
}

/** Identity excludes mutable resolution and reply fields so later turns survive Undo. */
export function annotationResolutionIdentity(editor: Editor, target: AnnotationTarget): string | null {
  if (target.kind === 'card') {
    const shape = editor.getShape(target.cardId as TLShapeId) as CardShape | undefined
    if (!shape || shape.type !== 'card') return null
    const comment = shape.props.comments.find((entry) => entry.id === target.commentId)
    if (!comment) return null
    return stableIdentity({
      kind: 'card', cardId: target.cardId, id: comment.id, type: comment.type,
      text: comment.text, author: comment.author, reviewId: comment.reviewId,
    })
  }
  const shape = editor.getShape(target.feedbackId as TLShapeId) as FeedbackShape | undefined
  if (!shape || shape.type !== 'feedback') return null
  return stableIdentity({
    kind: 'feedback', id: shape.id, type: shape.props.type, text: shape.props.text,
    authoredBy: shape.props.authoredBy, reviewId: shape.props.reviewId, reviewer: shape.props.reviewer,
  })
}

/** Targeted inverse: re-read the current record and touch only `resolved`. */
export function setAnnotationResolved(
  editor: Editor,
  target: AnnotationTarget,
  resolved: boolean,
  expectedIdentity?: string,
): boolean {
  if (expectedIdentity && annotationResolutionIdentity(editor, target) !== expectedIdentity) return false
  if (target.kind === 'card') {
    const shape = editor.getShape(target.cardId as TLShapeId) as CardShape | undefined
    if (!shape || shape.type !== 'card') return false
    const comment = shape.props.comments.find((entry) => entry.id === target.commentId)
    if (!comment || comment.resolved === resolved) return false
    editor.updateShape<CardShape>({
      id: shape.id,
      type: 'card',
      props: {
        comments: shape.props.comments.map((entry) =>
          entry.id === target.commentId ? { ...entry, resolved } : entry),
      },
    })
    return true
  }
  const shape = editor.getShape(target.feedbackId as TLShapeId) as FeedbackShape | undefined
  if (!shape || shape.type !== 'feedback' || shape.props.resolved === resolved) return false
  editor.updateShape<FeedbackShape>({ id: shape.id, type: 'feedback', props: { resolved } })
  return true
}

/** Capture before resolving because a floating feedback pin unmounts immediately. */
export function captureAnnotationCueAnchor(editor: Editor, target: AnnotationTarget): AnnotationCueAnchor | null {
  const container = editor.getContainer()
  const containerBounds = container.getBoundingClientRect()
  const key = target.kind === 'card'
    ? `card:${target.cardId}:${target.commentId}`
    : `feedback:${target.feedbackId}`
  const pin = [...container.querySelectorAll<HTMLElement>('[data-annotation-target]')]
    .find((element) => element.dataset.annotationTarget === key)
  if (!pin) return null
  const bounds = pin.getBoundingClientRect()
  const side = bounds.left + bounds.width / 2 < containerBounds.left + containerBounds.width / 2 ? 'right' : 'left'
  return {
    left: side === 'right'
      ? bounds.right - containerBounds.left + 8
      : bounds.left - containerBounds.left - 8,
    top: Math.max(8, Math.min(bounds.top - containerBounds.top, containerBounds.height - 48)),
    side,
  }
}
