import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type PointerEvent } from 'react'
import { agentInfo } from '../shapes/agents'
import { annotationPin, PIN_SIZE } from '../model/annotationPins'
import { threadMessages } from '../model/comments'
import { commentGist } from '../model/summary'
import type { Comment, CommentType } from '../model/types'
import {
  annotationTargetKey, dismissAnnotationPopoverSoon, requestAnnotationOpen,
  setAnnotationHover, type AnnotationTarget,
} from '../client/annotationSelection'
import './annotationThread.css'

export type AnnotationThreadComment = Pick<Comment, 'id' | 'type' | 'text' | 'resolved' | 'author' | 'messages'>

export interface AnnotationThreadProps {
  comment: AnnotationThreadComment
  mode: 'preview' | 'open'
  disabled?: boolean
  attribution?: string
  onResolve?: () => void
  running?: boolean
  streamingText?: string
  error?: string | null
  onReply?: (text: string) => void
  onRetry?: () => void
  onClose?: () => void
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
  disabled = false,
  attribution,
  onResolve,
  running = false,
  streamingText = '',
  error = null,
  onReply,
  onRetry,
  onClose,
}: AnnotationThreadProps) {
  const preview = mode === 'preview'
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
    if (!text || disabled || running || sending.current || !onReply) return
    sending.current = true
    setReply('')
    onReply(text)
  }
  return (
    <article
      className={`elves-annotation-thread elves-annotation-thread--${mode}`}
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
        {streamingText && <p className="elves-annotation-thread__message" data-author="claude"><span className="elves-annotation-thread__text">{streamingText}</span></p>}
      </div>
      {!preview && onReply && <form className="elves-annotation-thread__reply" onSubmit={send}>
        <textarea
          aria-label="Reply to annotation"
          value={reply}
          disabled={disabled || running}
          onChange={(event) => setReply(event.target.value)}
        />
        <button type="submit" className="elves-annotation-thread__send" disabled={disabled || running || !reply.trim()}>
          {running ? 'Replying…' : 'Send reply'}
        </button>
      </form>}
      {!preview && error && <div className="elves-annotation-thread__error" role="alert">{error} {onRetry && <button type="button" onClick={onRetry}>Retry</button>}</div>}
      {!preview && onResolve && <button
        type="button"
        className="elves-annotation-thread__resolve"
        aria-label={`Resolve ${type} comment`}
        disabled={disabled || !onResolve}
        onClick={onResolve}
      >
        Resolve comment
      </button>}
      {!preview && onClose && <button type="button" className="elves-annotation-thread__close" aria-label="Close annotation thread" onClick={onClose}>×</button>}
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
  target?: AnnotationTarget
}

/** A compact target that opens its shared foreground thread on demand. */
export function AnnotationPin({ comment, offsetY = 0, zoom = 1, className, target }: AnnotationPinProps) {
  const token = annotationPin(comment.type)
  const scale = 1 / zoom
  const style = {
    top: offsetY * scale,
    right: className?.includes('elves-feedback-pin') ? undefined : -36 * scale,
    left: className?.includes('elves-feedback-pin') ? 0 : undefined,
    '--annotation-pin-scale': scale,
  } as CSSProperties
  const stopPointer = (event: PointerEvent) => stopEvent(event)
  const open = (event: MouseEvent) => {
    stopEvent(event)
    if (target) requestAnnotationOpen(target)
  }
  const show = () => {
    if (target) setAnnotationHover(target)
  }
  const hide = () => {
    if (target) dismissAnnotationPopoverSoon(target)
  }

  return (
    <div
      className={`elves-annotation-pin-wrap${className ? ` ${className}` : ''}`}
      style={style}
      onPointerDown={stopPointer}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        className="elves-annotation-pin"
        data-type={token.tone}
        data-testid="annotation-pin"
        data-annotation-target={target ? annotationTargetKey(target) : undefined}
        aria-label={`Open ${token.label} comment from ${agentName(comment.author)}: ${commentGist(comment as Comment)}`}
        onClick={open}
      >
        <span aria-hidden="true" className="elves-annotation-pin__icon">{pinGlyph(token.icon)}</span>
      </button>
    </div>
  )
}

function stopEvent(event: PointerEvent | MouseEvent) {
  event.stopPropagation()
}

export { PIN_SIZE }
