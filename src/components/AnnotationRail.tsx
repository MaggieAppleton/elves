import { useValue, type Editor, type TLShapeId } from 'tldraw'
import type { ReactNode } from 'react'
import type { AnnotationTarget } from '../client/annotationSelection'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'
import { AnnotationThread } from './AnnotationThread'
import './annotationRail.css'

export interface AnnotationRailProps {
  target: AnnotationTarget
  editor: Editor | null
  disabled?: boolean
  onClose: () => void
  onResolve: (target: AnnotationTarget, commentId?: string) => void
  onRestore: (feedbackId: string) => void
  threadState?: { running: boolean; streamingText?: string; error?: string | null }
  onReply?: (target: AnnotationTarget, text: string) => void
  onRetry?: (target: AnnotationTarget) => void
}

export function AnnotationRail({ target, editor, disabled = false, onClose, onResolve, onRestore, threadState, onReply, onRetry }: AnnotationRailProps) {
  const shape = useValue(
    'annotation rail target',
    () => editor?.getShape((target.kind === 'card' ? target.cardId : target.feedbackId) as TLShapeId) ?? null,
    [editor, target],
  )

  let content: ReactNode
  if (!shape) {
    content = <p className="elves-annotation-rail__empty">This annotation is no longer on the canvas.</p>
  } else if (target.kind === 'card' && shape.type === 'card') {
    const card = shape as CardShape
    const comments = card.props.comments.filter((comment) => !comment.resolved)
    content = comments.length ? (
      <div className="elves-annotation-rail__list">
        {comments.map((comment) => (
          <AnnotationThread
            key={comment.id}
            comment={comment}
            mode="rail"
            selected={comment.id === target.commentId}
            disabled={disabled}
            onResolve={() => onResolve(target, comment.id)}
            running={threadState?.running && comment.id === target.commentId}
            streamingText={comment.id === target.commentId ? threadState?.streamingText : undefined}
            error={comment.id === target.commentId ? threadState?.error : undefined}
            onReply={onReply ? (text) => onReply({ kind: 'card', cardId: target.cardId, commentId: comment.id }, text) : undefined}
            onRetry={onRetry && comment.id === target.commentId ? () => onRetry(target) : undefined}
          />
        ))}
      </div>
    ) : <p className="elves-annotation-rail__empty">All comments on this card are resolved.</p>
  } else if (target.kind === 'feedback' && shape.type === 'feedback') {
    const feedback = shape as FeedbackShape
    content = (
      <AnnotationThread
        comment={{ id: feedback.id, type: feedback.props.type, text: feedback.props.text, resolved: feedback.props.resolved, author: feedback.props.authoredBy, messages: feedback.props.messages }}
        mode="rail"
        selected
        disabled={disabled}
        attribution={feedback.props.reviewer?.replaceAll('-', ' ')}
        actionLabel={feedback.props.resolved ? 'Restore feedback' : 'Resolve feedback'}
        onResolve={feedback.props.resolved ? () => onRestore(feedback.id) : () => onResolve(target)}
        running={threadState?.running}
        streamingText={threadState?.streamingText}
        error={threadState?.error}
        onReply={onReply ? (text) => onReply(target, text) : undefined}
        onRetry={onRetry ? () => onRetry(target) : undefined}
      />
    )
  } else {
    content = <p className="elves-annotation-rail__empty">This annotation is unavailable.</p>
  }

  return (
    <aside className="elves-annotation-rail" data-testid="annotation-rail" aria-label="Annotation inspector">
      <header className="elves-annotation-rail__header">
        <div>
          <div className="elves-annotation-rail__eyebrow">Agent annotation</div>
          <h2>Inspector</h2>
        </div>
        <button type="button" className="elves-annotation-rail__close" aria-label="Close annotation" onClick={onClose}>×</button>
      </header>
      <div className="elves-annotation-rail__scroll">{content}</div>
    </aside>
  )
}
