import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import {
  ArrowBendUpLeft, ArrowsLeftRight, Buildings, ChartLineDown, ChatCircleDots, Checks, ImageSquare,
  Link, PaperPlaneRight, Question, Scissors, Warning, X,
} from '@phosphor-icons/react'
import { authorInfo } from '../shapes/agents'
import { annotationPin, PIN_SIZE, type AnnotationPinIcon } from '../model/annotationPins'
import { threadMessages } from '../model/comments'
import { commentGist } from '../model/summary'
import type { Comment } from '../model/types'
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
  /** Pixel cap measured from the live tldraw stage by the foreground owner. */
  maxHeight?: number
}

const REPLY_MIN_HEIGHT = 76

function agentName(id: string): string {
  return authorInfo(id)?.name ?? id
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
  maxHeight,
}: AnnotationThreadProps) {
  const preview = mode === 'preview'
  const token = annotationPin(comment.type)
  const TypeIcon = PIN_ICONS[token.icon]
  const [reply, setReply] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [replyMinimumHeight, setReplyMinimumHeight] = useState(REPLY_MIN_HEIGHT)
  const sending = useRef(false)
  const replyInputRef = useRef<HTMLTextAreaElement>(null)
  const replyResize = useRef<{ pointerId: number, startY: number, startHeight: number } | null>(null)
  const messages = threadMessages(comment)
  useEffect(() => {
    if (!running) sending.current = false
  }, [running])
  useLayoutEffect(() => {
    const input = replyInputRef.current
    if (!composerOpen || !input) return
    input.style.height = 'auto'
    input.style.height = `${Math.max(input.scrollHeight, replyMinimumHeight)}px`
  }, [composerOpen, reply, replyMinimumHeight])

  const beginReplyResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || running) return
    const inputHeight = replyInputRef.current?.getBoundingClientRect().height ?? replyMinimumHeight
    replyResize.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: Math.max(REPLY_MIN_HEIGHT, inputHeight),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const resizeReply = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || running) return
    const resize = replyResize.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setReplyMinimumHeight(Math.max(REPLY_MIN_HEIGHT, resize.startHeight + event.clientY - resize.startY))
  }
  const endReplyResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (replyResize.current?.pointerId === event.pointerId) replyResize.current = null
  }
  const resizeReplyWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    if (disabled || running) return
    setReplyMinimumHeight((height) => Math.max(REPLY_MIN_HEIGHT, height + (event.key === 'ArrowDown' ? 8 : -8)))
  }
  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = reply.trim()
    if (!text || disabled || running || sending.current || !onReply) return
    sending.current = true
    setReply('')
    setReplyMinimumHeight(REPLY_MIN_HEIGHT)
    setComposerOpen(false)
    onReply(text)
  }
  return (
    <article
      className={`elves-annotation-thread elves-annotation-thread--${mode}`}
      data-testid="annotation-thread"
      style={maxHeight === undefined ? undefined : { maxHeight }}
    >
      <header className="elves-annotation-thread__header">
        <div className="elves-annotation-thread__meta">
          <span className="elves-annotation-thread__type" data-type={token.tone}>
            <TypeIcon aria-hidden="true" size={14} weight="bold" />
            {token.label}
          </span>
          {attribution && <span>{attribution}</span>}
        </div>
        {!preview && (onResolve || onClose) && <div className="elves-annotation-thread__actions">
          {onResolve && <button type="button" className="elves-annotation-thread__resolve" aria-label={`Resolve ${token.label} comment`} disabled={disabled} onClick={onResolve}>
            <Checks aria-hidden="true" size={14} weight="bold" />
            Resolve
          </button>}
          {onClose && <button type="button" className="elves-annotation-thread__close" aria-label="Close annotation thread" onClick={onClose}>
            <X aria-hidden="true" size={15} weight="bold" />
          </button>}
        </div>}
      </header>
      <div className="elves-annotation-thread__messages">
        {messages.map((message) => (
          <p key={message.id} className="elves-annotation-thread__message" data-author={message.author}>
            <span className="elves-annotation-thread__message-author">{agentName(message.author)}</span>
            <span className="elves-annotation-thread__text">{message.text}</span>
          </p>
        ))}
        {streamingText && <p className="elves-annotation-thread__message" data-author="claude"><span className="elves-annotation-thread__message-author">{agentName('claude')}</span><span className="elves-annotation-thread__text">{streamingText}</span></p>}
      </div>
      {!preview && onReply && <button
        type="button"
        className="elves-annotation-thread__reply-trigger"
        aria-label="Reply to annotation"
        hidden={composerOpen}
        disabled={disabled || running}
        onClick={() => setComposerOpen(true)}
      >
        <ArrowBendUpLeft aria-hidden="true" size={15} weight="bold" />
      </button>}
      {!preview && onReply && composerOpen && <form className="elves-annotation-thread__reply" onSubmit={send}>
        <textarea
          aria-label="Reply to annotation"
          autoFocus
          ref={replyInputRef}
          value={reply}
          disabled={disabled || running}
          onChange={(event) => setReply(event.target.value)}
          style={{ minHeight: `${replyMinimumHeight}px` }}
        />
        <button
          type="button"
          className="elves-annotation-thread__reply-resize"
          aria-label="Resize reply editor"
          aria-orientation="horizontal"
          disabled={disabled || running}
          onPointerDown={beginReplyResize}
          onPointerMove={resizeReply}
          onPointerUp={endReplyResize}
          onPointerCancel={endReplyResize}
          onKeyDown={resizeReplyWithKeyboard}
        />
        <button
          type="submit"
          className="elves-annotation-thread__send"
          aria-label={running ? 'Replying to annotation' : 'Send reply'}
          disabled={disabled || running || !reply.trim()}
        >
          <PaperPlaneRight aria-hidden="true" size={15} weight="bold" />
        </button>
      </form>}
      {!preview && error && <div className="elves-annotation-thread__error" role="alert">{error} {onRetry && <button
        type="button"
        className="elves-annotation-thread__retry"
        disabled={disabled || running}
        onClick={() => {
          if (!disabled && !running) onRetry()
        }}
      >
        Retry
      </button>}</div>}
    </article>
  )
}

const PIN_ICONS: Record<AnnotationPinIcon, typeof Warning> = {
  comment: ChatCircleDots,
  warning: Warning,
  'chart-down': ChartLineDown,
  link: Link,
  image: ImageSquare,
  arrows: ArrowsLeftRight,
  scissors: Scissors,
  question: Question,
  buildings: Buildings,
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
  const Icon = PIN_ICONS[token.icon]
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
        <span aria-hidden="true" className="elves-annotation-pin__icon">
          <Icon aria-hidden="true" size={15} weight="bold" />
        </span>
      </button>
    </div>
  )
}

function stopEvent(event: PointerEvent | MouseEvent) {
  event.stopPropagation()
}

export { PIN_SIZE }
