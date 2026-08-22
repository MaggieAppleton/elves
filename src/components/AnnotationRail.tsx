import { useValue, type Editor, type TLShapeId } from 'tldraw'
import type { ReactNode } from 'react'
import { agentInfo } from '../shapes/agents'
import type { AnnotationTarget } from '../client/annotationSelection'
import type { Comment } from '../model/types'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'
import './annotationRail.css'

export interface AnnotationRailProps {
  target: AnnotationTarget
  editor: Editor | null
  disabled?: boolean
  onClose: () => void
  onResolve: (target: AnnotationTarget, commentId?: string) => void
  onRestore: (feedbackId: string) => void
}

function annotationType(type: string | null): string {
  return type ? type.replaceAll('-', ' ') : 'feedback'
}

function agentName(id: string): string {
  return agentInfo(id)?.name ?? id
}

function CommentItem({
  comment,
  selected,
  disabled,
  onResolve,
}: {
  comment: Comment
  selected: boolean
  disabled: boolean
  onResolve: () => void
}) {
  return (
    <article className="elves-annotation-rail__item" data-selected={selected} data-testid="annotation-item">
      <div className="elves-annotation-rail__meta">
        <span className="elves-annotation-rail__type">{annotationType(comment.type)}</span>
        <span>{agentName(comment.author)}</span>
      </div>
      <p className="elves-annotation-rail__text">{comment.text}</p>
      <button type="button" className="elves-annotation-rail__resolve" disabled={disabled} onClick={onResolve}>
        Resolve comment
      </button>
    </article>
  )
}

export function AnnotationRail({ target, editor, disabled = false, onClose, onResolve, onRestore }: AnnotationRailProps) {
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
          <CommentItem
            key={comment.id}
            comment={comment}
            selected={comment.id === target.commentId}
            disabled={disabled}
            onResolve={() => onResolve(target, comment.id)}
          />
        ))}
      </div>
    ) : <p className="elves-annotation-rail__empty">All comments on this card are resolved.</p>
  } else if (target.kind === 'feedback' && shape.type === 'feedback') {
    const feedback = shape as FeedbackShape
    content = (
      <article className="elves-annotation-rail__item" data-selected="true" data-testid="annotation-item">
        <div className="elves-annotation-rail__meta">
          <span className="elves-annotation-rail__type">{annotationType(feedback.props.type)}</span>
          <span>{agentName(feedback.props.authoredBy)}</span>
          {feedback.props.reviewer && <span>{feedback.props.reviewer.replaceAll('-', ' ')}</span>}
        </div>
        <p className="elves-annotation-rail__text">{feedback.props.text}</p>
        {feedback.props.resolved ? (
          <button type="button" className="elves-annotation-rail__resolve" disabled={disabled} onClick={() => onRestore(feedback.id)}>
            Restore feedback
          </button>
        ) : (
          <button type="button" className="elves-annotation-rail__resolve" disabled={disabled} onClick={() => onResolve(target)}>
            Resolve feedback
          </button>
        )}
      </article>
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
