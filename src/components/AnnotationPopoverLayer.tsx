import { useEffect, useState, type KeyboardEvent } from 'react'
import { useEditor, useValue, type TLShapeId } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'
import {
  annotationPopover, annotationRepliesLocked, annotationTargetKey, annotationThreadPresentation,
  dismissAnnotationPopoverSoon, requestAnnotationReply, requestAnnotationRetry, showAnnotationPopover,
  subscribeAnnotationPopover, subscribeAnnotationThreadPresentation,
  type AnnotationTarget,
} from '../client/annotationSelection'
import { AnnotationThread, type AnnotationThreadComment } from './AnnotationThread'

type PopoverContent = { comment: AnnotationThreadComment; attribution?: string }

function contentForTarget(target: AnnotationTarget, shape: unknown): PopoverContent | null {
  if (target.kind === 'card' && (shape as CardShape | null)?.type === 'card') {
    const comment = (shape as CardShape).props.comments.find((entry) => entry.id === target.commentId)
    return comment && !comment.resolved ? { comment } : null
  }
  if (target.kind === 'feedback' && (shape as FeedbackShape | null)?.type === 'feedback') {
    const feedback = shape as FeedbackShape
    return feedback.props.resolved ? null : {
      comment: {
        id: feedback.id, type: feedback.props.type, text: feedback.props.text,
        resolved: feedback.props.resolved, author: feedback.props.authoredBy, messages: feedback.props.messages,
      },
      attribution: feedback.props.reviewer?.replaceAll('-', ' '),
    }
  }
  return null
}

/** Renders the one expanded annotation above tldraw's shape stack. */
export function AnnotationPopoverLayer() {
  const editor = useEditor()
  const [target, setTarget] = useState<AnnotationTarget | null>(() => annotationPopover())
  const [, setThreadVersion] = useState(0)
  const targetKey = target ? annotationTargetKey(target) : ''
  const shape = useValue(
    'annotation popover target',
    () => target ? editor.getShape((target.kind === 'card' ? target.cardId : target.feedbackId) as TLShapeId) : null,
    [editor, targetKey],
  )
  // This reactive read keeps the page-space pin and overlay together while panning or zooming.
  useValue('annotation popover camera', () => editor.getCamera(), [editor])

  useEffect(() => subscribeAnnotationPopover(() => setTarget(annotationPopover())), [])
  useEffect(() => subscribeAnnotationThreadPresentation(() => setThreadVersion((version) => version + 1)), [])

  if (!target) return null
  const content = contentForTarget(target, shape)
  if (!content || typeof document === 'undefined') return null
  const pin = [...document.querySelectorAll<HTMLElement>('[data-annotation-target]')]
    .find((element) => element.dataset.annotationTarget === targetKey)
  if (!pin) return null

  const pinBounds = pin.getBoundingClientRect()
  const canvasBounds = editor.getContainer().getBoundingClientRect()
  const presentation = annotationThreadPresentation(target)
  const returnFocusToPin = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !event.shiftKey || typeof document === 'undefined') return
    const firstFocusable = event.currentTarget.querySelector<HTMLElement>('textarea:not(:disabled), button:not(:disabled), [href]')
    if (event.target !== firstFocusable) return
    event.preventDefault()
    pin.focus()
  }

  return (
    <div className="elves-annotation-popover-layer" aria-live="polite">
      <div
        className="elves-annotation-popover elves-annotation-popover--front"
        data-testid="annotation-popover"
        data-annotation-popover-target={targetKey}
        style={{ left: pinBounds.left - canvasBounds.left, top: pinBounds.top - canvasBounds.top - 8 }}
        onPointerEnter={() => showAnnotationPopover(target)}
        onPointerLeave={() => dismissAnnotationPopoverSoon(target)}
        onFocus={() => showAnnotationPopover(target)}
        onBlur={() => dismissAnnotationPopoverSoon(target)}
        onKeyDown={returnFocusToPin}
      >
        <AnnotationThread
          comment={content.comment}
          mode="popover"
          attribution={content.attribution}
          running={presentation?.running}
          streamingText={presentation?.streamingText}
          error={presentation?.error}
          disabled={annotationRepliesLocked()}
          onReply={(text) => requestAnnotationReply(target, text)}
          onRetry={() => requestAnnotationRetry(target)}
        />
      </div>
    </div>
  )
}
