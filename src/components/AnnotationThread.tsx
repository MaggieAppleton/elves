import type { CSSProperties, MouseEvent, PointerEvent } from 'react'
import { agentInfo } from '../shapes/agents'
import { annotationPin, PIN_SIZE } from '../model/annotationPins'
import type { Comment, CommentType } from '../model/types'
import './annotationThread.css'

export type AnnotationThreadComment = Pick<Comment, 'id' | 'type' | 'text' | 'resolved' | 'author'>

export interface AnnotationThreadProps {
  comment: AnnotationThreadComment
  mode: 'popover' | 'rail'
  selected?: boolean
  disabled?: boolean
  attribution?: string
  actionLabel?: string
  onResolve?: () => void
}

function annotationType(type: CommentType | null): string {
  return annotationPin(type).label
}

function agentName(id: string): string {
  return agentInfo(id)?.name ?? id
}

export function AnnotationThread({
  comment,
  mode,
  selected = false,
  disabled = false,
  attribution,
  actionLabel = 'Resolve comment',
  onResolve,
}: AnnotationThreadProps) {
  const type = annotationType(comment.type)
  return (
    <article
      className={`elves-annotation-thread elves-annotation-thread--${mode}`}
      data-selected={selected}
      data-testid="annotation-thread"
    >
      <div className="elves-annotation-thread__meta">
        <span className="elves-annotation-thread__type">{type}</span>
        <span>{agentName(comment.author)}</span>
        {attribution && <span>{attribution}</span>}
      </div>
      <p className="elves-annotation-thread__text">{comment.text}</p>
      <button
        type="button"
        className="elves-annotation-thread__resolve"
        aria-label={`${actionLabel.replace(/ comment$| feedback$/, '')} ${type} ${comment.resolved ? 'feedback' : 'comment'}`}
        disabled={disabled || !onResolve}
        onClick={onResolve}
      >
        {actionLabel}
      </button>
    </article>
  )
}

function pinGlyph(icon: string): string {
  return ({
    quote: '“', warning: '!', link: '↗', image: '▧', arrows: '↔',
    scissors: '✂', question: '?', branch: '⌘', message: '•',
  } as Record<string, string>)[icon] ?? '•'
}

export interface AnnotationPinProps {
  comment: AnnotationThreadComment
  offsetY?: number
  zoom?: number
  className?: string
  attribution?: string
  onOpen: () => void
}

/** A compact target whose adjacent popover shares the inspector's thread view. */
export function AnnotationPin({ comment, offsetY = 0, zoom = 1, className, attribution, onOpen }: AnnotationPinProps) {
  const token = annotationPin(comment.type)
  const scale = 1 / zoom
  const style = {
    top: offsetY * scale,
    right: -36 * scale,
    '--annotation-pin-scale': scale,
  } as CSSProperties
  const stopPointer = (event: PointerEvent) => stopEvent(event)
  const open = (event: MouseEvent) => {
    stopEvent(event)
    onOpen()
  }

  return (
    <div className={`elves-annotation-pin-wrap${className ? ` ${className}` : ''}`} style={style} onPointerDown={stopPointer}>
      <button
        type="button"
        className="elves-annotation-pin"
        data-type={token.tone}
        data-testid="annotation-pin"
        aria-label={`Open ${token.label} comment from ${agentName(comment.author)}`}
        onClick={open}
      >
        <span aria-hidden="true" className="elves-annotation-pin__icon">{pinGlyph(token.icon)}</span>
      </button>
      <div className="elves-annotation-popover" data-testid="annotation-popover">
        <AnnotationThread comment={comment} mode="popover" attribution={attribution} />
      </div>
    </div>
  )
}

function stopEvent(event: PointerEvent | MouseEvent) {
  event.stopPropagation()
}

export { PIN_SIZE }
