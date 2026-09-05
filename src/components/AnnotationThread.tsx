import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowBendUpLeft, ArrowsLeftRight, Buildings, ChartLineDown, ChatCircleDots, Check, ImageSquare,
  Link, PaperPlaneRight, Question, Scissors, Warning, X,
} from '@phosphor-icons/react'
import { authorInfo } from '../shapes/agents'
import { annotationPin, PIN_SIZE, type AnnotationPinIcon } from '../model/annotationPins'
import { threadMessages } from '../model/comments'
import { commentGist } from '../model/summary'
import type { Comment } from '../model/types'
import {
  annotationTargetKey, dismissAnnotationPopoverSoon, requestAnnotationOpen,
  setAnnotationHover, type AnnotationInteractionOrigin, type AnnotationTarget,
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
  phase?: 'saving' | 'awaiting-first-token' | 'streaming' | 'failed'
  replyMessageId?: string
  streamingText?: string
  error?: string | null
  draft?: string
  onDraftChange?: (text: string) => void
  onDiscardDraft?: () => void
  onReply?: (text: string) => void
  onRetry?: () => void
  onClose?: (origin?: AnnotationInteractionOrigin) => void
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
  phase,
  replyMessageId,
  streamingText = '',
  error = null,
  draft,
  onDraftChange,
  onDiscardDraft,
  onReply,
  onRetry,
  onClose,
  maxHeight,
}: AnnotationThreadProps) {
  const preview = mode === 'preview'
  const token = annotationPin(comment.type)
  const TypeIcon = PIN_ICONS[token.icon]
  const [localReply, setLocalReply] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [showNewest, setShowNewest] = useState(false)
  const [completionAnnouncement, setCompletionAnnouncement] = useState('')
  const sending = useRef(false)
  const restoreFocus = useRef(false)
  const previousPhase = useRef<typeof phase>()
  const latestReplyMessageId = useRef<string>()
  const replyInputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  if (replyMessageId) latestReplyMessageId.current = replyMessageId
  const messages = threadMessages(comment)
  const completedReplyId = latestReplyMessageId.current ? `${latestReplyMessageId.current}:claude` : null
  const completedReply = completedReplyId ? messages.find((message) => message.id === completedReplyId) : undefined
  const transcriptMessages = completedReply ? messages.filter((message) => message.id !== completedReplyId) : messages
  const reply = draft ?? localReply
  const responseVisible = phase === 'awaiting-first-token' || phase === 'streaming' || !!completedReply
  const setReply = (text: string) => {
    if (draft === undefined) setLocalReply(text)
    onDraftChange?.(text)
  }
  const initialMessage = messages[0]
  const replyCount = Math.max(0, messages.length - 1)
  useEffect(() => {
    if (!running) sending.current = false
  }, [running])
  useEffect(() => {
    const previous = previousPhase.current
    if (phase === 'awaiting-first-token') setCompletionAnnouncement('')
    if ((previous === 'awaiting-first-token' || previous === 'streaming') && phase === undefined) {
      setCompletionAnnouncement('Claude replied')
    }
    previousPhase.current = phase
  }, [phase])
  useLayoutEffect(() => {
    const input = replyInputRef.current
    if (!composerOpen || !input) return
    input.style.height = 'auto'
    input.style.height = `${Math.max(input.scrollHeight, REPLY_MIN_HEIGHT)}px`
  }, [composerOpen, reply])
  useLayoutEffect(() => {
    const transcript = messagesRef.current
    if (!transcript) return
    if (atBottomRef.current) {
      transcript.scrollTop = transcript.scrollHeight
      setShowNewest(false)
    } else {
      setShowNewest(true)
    }
  }, [messages.length, phase, streamingText])
  useEffect(() => {
    if (composerOpen || !restoreFocus.current) return
    restoreFocus.current = false
    messagesRef.current?.focus()
  }, [composerOpen])
  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = reply.trim()
    if (!text || disabled || running || sending.current || !onReply) return
    sending.current = true
    if (draft === undefined) setLocalReply('')
    restoreFocus.current = true
    setComposerOpen(false)
    onReply(text)
  }
  const discard = () => {
    if (onDiscardDraft) onDiscardDraft()
    else setReply('')
    restoreFocus.current = true
    setComposerOpen(false)
  }
  if (preview) {
    const previewAuthor = attribution ?? agentName(initialMessage.author)
    const previewName = `Annotation preview: ${token.label} from ${previewAuthor}: ${initialMessage.text}${replyCount ? ` ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : ''}`
    return (
      <article
        className="elves-annotation-thread elves-annotation-thread--preview"
        data-testid="annotation-thread"
        aria-label={previewName}
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        <header className="elves-annotation-thread__header">
          <div className="elves-annotation-thread__meta">
            <span className="elves-annotation-thread__type" data-type={token.tone}>
              <TypeIcon aria-hidden="true" size={14} weight="bold" />
              {token.label}
            </span>
            <span>{previewAuthor}</span>
          </div>
          {replyCount > 0 && <span className="elves-annotation-thread__reply-count" aria-label={`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}>
            <ChatCircleDots aria-hidden="true" size={13} weight="bold" />
            {replyCount}
          </span>}
        </header>
        <p className="elves-annotation-thread__preview-excerpt">{initialMessage.text}</p>
      </article>
    )
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
          {onResolve && <ActionTooltip label={`Resolve ${token.label} comment`}>
            {(tooltipId) => <button type="button" className="elves-annotation-thread__resolve" aria-label={`Resolve ${token.label} comment`} aria-describedby={tooltipId} disabled={disabled} onClick={onResolve}>
              <Check aria-hidden="true" size={16} weight="bold" />
            </button>}
          </ActionTooltip>}
          {onClose && <ActionTooltip label="Close annotation thread">
            {(tooltipId) => <button type="button" className="elves-annotation-thread__close" aria-label="Close annotation thread" aria-describedby={tooltipId} onClick={(event) => onClose(event?.detail === 0 ? 'keyboard' : 'pointer')}>
              <X aria-hidden="true" size={16} weight="bold" />
            </button>}
          </ActionTooltip>}
        </div>}
      </header>
      <div
        ref={messagesRef}
        className="elves-annotation-thread__messages"
        tabIndex={-1}
        onScroll={(event) => {
          const transcript = event.currentTarget
          atBottomRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 4
          if (atBottomRef.current) setShowNewest(false)
        }}
      >
        {transcriptMessages.map((message) => (
          <p
            key={message.id}
            className={`elves-annotation-thread__message${message.id === replyMessageId && (phase === 'awaiting-first-token' || phase === 'streaming') ? ' elves-annotation-thread__message--reply-transition' : ''}`}
            data-author={message.author}
          >
            <span className="elves-annotation-thread__message-author">{agentName(message.author)}</span>
            <span className="elves-annotation-thread__text">{message.text}</span>
          </p>
        ))}
        {responseVisible && <p
          key={completedReplyId ?? 'pending-claude-reply'}
          className="elves-annotation-thread__message"
          data-author="claude"
          data-reply-phase={phase}
          role={phase === 'awaiting-first-token' ? 'status' : undefined}
          aria-live={phase === 'awaiting-first-token' ? 'polite' : 'off'}
        >
          <span className="elves-annotation-thread__message-author">{agentName('claude')}</span>
          <span className="elves-annotation-thread__text">
            {phase === 'awaiting-first-token' ? 'Claude is replying' : completedReply?.text ?? streamingText}
          </span>
        </p>}
      </div>
      {showNewest && <button
        type="button"
        className="elves-annotation-thread__newest"
        onClick={() => {
          const transcript = messagesRef.current
          if (!transcript) return
          transcript.scrollTop = transcript.scrollHeight
          atBottomRef.current = true
          setShowNewest(false)
          transcript.focus()
        }}
      >
        Newest reply
      </button>}
      {completionAnnouncement && <p
        className="elves-annotation-thread__announcement"
        role="status"
        aria-live="polite"
      >
        {completionAnnouncement}
      </p>}
      {!preview && onReply && !composerOpen && <ActionTooltip label="Reply to annotation">
        {(tooltipId) => <button
          type="button"
          className="elves-annotation-thread__reply-trigger"
          aria-label="Reply to annotation"
          aria-describedby={tooltipId}
          disabled={disabled || running}
          onClick={() => setComposerOpen(true)}
        >
          <ArrowBendUpLeft aria-hidden="true" size={16} weight="bold" />
        </button>}
      </ActionTooltip>}
      {!preview && onReply && composerOpen && <form className="elves-annotation-thread__reply" onSubmit={send}>
        <textarea
          aria-label="Reply to annotation"
          autoFocus
          ref={replyInputRef}
          value={reply}
          disabled={disabled || running}
          onChange={(event) => setReply(event.target.value)}
          style={{}}
        />
        {reply && <button
          type="button"
          className="elves-annotation-thread__discard"
          aria-label="Discard reply draft"
          disabled={disabled || running}
          onClick={discard}
        >
          <X aria-hidden="true" size={14} weight="bold" />
        </button>}
        <ActionTooltip label={running ? 'Replying to annotation' : 'Send reply'}>
          {(tooltipId) => <button
            type="submit"
            className="elves-annotation-thread__send"
            aria-label={running ? 'Replying to annotation' : 'Send reply'}
            aria-describedby={tooltipId}
            disabled={disabled || running || !reply.trim()}
          >
            <PaperPlaneRight aria-hidden="true" size={16} weight="bold" />
          </button>}
        </ActionTooltip>
      </form>}
      {!preview && error && <div className="elves-annotation-thread__error" role="alert">
        <div className="elves-annotation-thread__error-message">
          <Warning aria-hidden="true" size={16} weight="fill" />
          {error}
        </div>
        {onRetry && <button
          type="button"
          className="elves-annotation-thread__retry"
          disabled={disabled || running}
          onClick={() => {
            if (!disabled && !running) onRetry()
          }}
        >
          Retry
        </button>}
      </div>}
    </article>
  )
}

function ActionTooltip({ label, children }: { label: string; children: (tooltipId: string) => ReactNode }) {
  const tooltipId = useId()
  const [visible, setVisible] = useState(false)
  return (
    <span
      className="elves-annotation-thread__action-tooltip"
      onPointerEnter={() => setVisible(true)}
      onPointerLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => setVisible(false)}
    >
      {children(tooltipId)}
      <span id={tooltipId} role="tooltip" className="elves-annotation-thread__tooltip" data-state={visible ? 'open' : 'closed'}>{label}</span>
    </span>
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
  const stopPointer = (event: PropagationEvent) => stopEvent(event)
  const open = (event: MouseEvent) => {
    stopEvent(event)
    if (target) requestAnnotationOpen(target, event.detail === 0 ? 'keyboard' : 'pointer')
  }
  const showPointer = () => {
    if (target) setAnnotationHover(target, 'pointer')
  }
  const showKeyboard = () => {
    if (target) setAnnotationHover(target, 'keyboard')
  }
  const hide = () => {
    if (target) dismissAnnotationPopoverSoon(target)
  }

  return (
    <div
      className={`elves-annotation-pin-wrap${className ? ` ${className}` : ''}`}
      style={style}
      onPointerDown={stopPointer}
      onPointerEnter={showPointer}
      onPointerLeave={hide}
      onFocus={showKeyboard}
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

type PropagationEvent = { stopPropagation: () => void }

function stopEvent(event: PropagationEvent | MouseEvent) {
  event.stopPropagation()
}

export { PIN_SIZE }
