import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type PointerEvent } from 'react'
import { agentInfo } from '../shapes/agents'
import { annotationPin, PIN_SIZE } from '../model/annotationPins'
import { threadMessages } from '../model/comments'
import type { Comment, CommentType } from '../model/types'
import {
  annotationThreadPresentation, subscribeAnnotationThreadPresentation,
  type AnnotationTarget,
} from '../client/annotationSelection'
import './annotationThread.css'

export type AnnotationThreadComment = Pick<Comment, 'id' | 'type' | 'text' | 'resolved' | 'author' | 'messages'>

export interface AnnotationThreadProps {
  comment: AnnotationThreadComment
  mode: 'popover' | 'rail'
  selected?: boolean
  disabled?: boolean
  attribution?: string
  actionLabel?: string
  onResolve?: () => void
  running?: boolean
  streamingText?: string
  error?: string | null
  onReply?: (text: string) => void
  onRetry?: () => void
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
  running = false,
  streamingText = '',
  error = null,
  onReply,
  onRetry,
}: AnnotationThreadProps) {
  const type = annotationType(comment.type)
  const [reply, setReply] = useState('')
  const sending = useRef(false)
  const messages = threadMessages(comment)
  useEffect(() => {
    if (!running) sending.current = false
  }, [running])
  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = reply.trim()
    if (!text || running || sending.current || !onReply) return
    sending.current = true
    setReply('')
    onReply(text)
  }
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
      <div className="elves-annotation-thread__messages">
        {messages.map((message) => (
          <p key={message.id} className="elves-annotation-thread__message" data-author={message.author}>
            <span className="elves-annotation-thread__message-author">{agentName(message.author)}</span>
            <span className="elves-annotation-thread__text">{message.text}</span>
          </p>
        ))}
        {streamingText && <p className="elves-annotation-thread__message" data-author="claude">{streamingText}</p>}
      </div>
      {onReply && <form className="elves-annotation-thread__reply" onSubmit={send}>
        <textarea
          aria-label="Reply to annotation"
          value={reply}
          disabled={running}
          onChange={(event) => setReply(event.target.value)}
        />
        <button type="submit" className="elves-annotation-thread__send" disabled={running || !reply.trim()}>
          {running ? 'Replying…' : 'Send reply'}
        </button>
      </form>}
      {error && <div className="elves-annotation-thread__error" role="alert">{error} {onRetry && <button type="button" onClick={onRetry}>Retry</button>}</div>}
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
  target?: AnnotationTarget
  onOpen: () => void
  onReply?: (target: AnnotationTarget, text: string) => void
  onRetry?: (target: AnnotationTarget) => void
}

/** A compact target whose adjacent popover shares the inspector's thread view. */
export function AnnotationPin({ comment, offsetY = 0, zoom = 1, className, attribution, target, onOpen, onReply, onRetry }: AnnotationPinProps) {
  const token = annotationPin(comment.type)
  const [presentation, setPresentation] = useState(() => target ? annotationThreadPresentation(target) : undefined)
  useEffect(() => {
    if (!target) return
    const update = () => setPresentation(annotationThreadPresentation(target))
    update()
    return subscribeAnnotationThreadPresentation(update)
  }, [target?.kind, target?.kind === 'card' ? target.cardId : target?.feedbackId, target?.kind === 'card' ? target.commentId : undefined])
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
        <AnnotationThread comment={comment} mode="popover" attribution={attribution}
          running={presentation?.running}
          streamingText={presentation?.streamingText}
          error={presentation?.error}
          onReply={target && onReply ? (text) => onReply(target, text) : undefined}
          onRetry={target && onRetry ? () => onRetry(target) : undefined} />
      </div>
    </div>
  )
}

function stopEvent(event: PointerEvent | MouseEvent) {
  event.stopPropagation()
}

export { PIN_SIZE }
