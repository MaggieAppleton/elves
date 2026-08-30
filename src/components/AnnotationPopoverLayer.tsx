import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useEditor, useValue, type Editor, type TLShapeId } from 'tldraw'
import { placeAnnotationThread, type AnnotationPlacement } from '../client/annotationPlacement'
import {
  annotationHoverTarget, annotationOpenTargets, annotationRepliesLocked, annotationTargetKey,
  annotationThreadPresentation, dismissAnnotationPopoverSoon, pruneAnnotationThreads,
  requestAnnotationClose, requestAnnotationReply, requestAnnotationResolve, requestAnnotationRetry,
  setAnnotationHover, subscribeAnnotationTargets, subscribeAnnotationThreadPresentation,
  type AnnotationTarget,
} from '../client/annotationSelection'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'
import { AnnotationThread, type AnnotationThreadComment, type AnnotationThreadProps } from './AnnotationThread'

type PopoverContent = { comment: AnnotationThreadComment; attribution?: string }

export type ForegroundEntry = {
  target: AnnotationTarget
  mode: 'preview' | 'open'
  zIndex: number
}

/** Ordered canvas overlays: promoted threads stay on top, with one hover preview. */
export function foregroundEntries(
  open: AnnotationTarget[],
  hovered: AnnotationTarget | null = null,
): ForegroundEntry[] {
  const entries: ForegroundEntry[] = []
  if (hovered && !open.some((target) => annotationTargetKey(target) === annotationTargetKey(hovered))) {
    entries.push({ target: hovered, mode: 'preview', zIndex: open.length + 1 })
  }
  open.forEach((target, index) => entries.push({ target, mode: 'open', zIndex: index + 1 }))
  return entries
}

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

function samePlacement(a: AnnotationPlacement | null, b: AnnotationPlacement): boolean {
  return a?.left === b.left && a.top === b.top && a.side === b.side
}

interface AnnotationForegroundItemProps {
  target: AnnotationTarget
  mode: ForegroundEntry['mode']
  zIndex: number
  editor: Editor
}

/** Build the controls for exactly one foreground target. Presentation state is
 * keyed by the target, so simultaneous annotation runs never borrow another
 * thread's loading, error, or retry state. */
export function foregroundThreadProps(target: AnnotationTarget): Pick<AnnotationThreadProps,
  'running' | 'streamingText' | 'error' | 'disabled' | 'onReply' | 'onRetry' | 'onResolve' | 'onClose'
> {
  const presentation = annotationThreadPresentation(target)
  return {
    running: presentation?.running,
    streamingText: presentation?.streamingText,
    error: presentation?.error,
    disabled: annotationRepliesLocked(),
    onReply: (text) => requestAnnotationReply(target, text),
    onRetry: () => requestAnnotationRetry(target),
    onResolve: () => requestAnnotationResolve(target),
    onClose: () => requestAnnotationClose(target),
  }
}

function AnnotationForegroundItem({ target, mode, zIndex, editor }: AnnotationForegroundItemProps) {
  const targetKey = annotationTargetKey(target)
  const panelRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<AnnotationPlacement | null>(null)
  const shape = useValue(
    `annotation foreground target ${targetKey}`,
    () => editor.getShape((target.kind === 'card' ? target.cardId : target.feedbackId) as TLShapeId),
    [editor, targetKey],
  )
  // Pins move in page space as the camera moves, so placement tracks the live camera.
  const camera = useValue(`annotation foreground camera ${targetKey}`, () => editor.getCamera(), [editor])
  const content = useMemo(() => contentForTarget(target, shape), [shape, target])

  useEffect(() => {
    if (mode !== 'open' || content) return
    pruneAnnotationThreads((openTarget) => annotationTargetKey(openTarget) !== targetKey)
  }, [content, mode, targetKey])

  useEffect(() => {
    if (!content) {
      setPlacement(null)
      return
    }

    let frame: number | null = null
    const updatePlacement = () => {
      frame = null
      const panel = panelRef.current
      const canvas = editor.getContainer()
      const pin = [...canvas.querySelectorAll<HTMLElement>('[data-annotation-target]')]
        .find((element) => element.dataset.annotationTarget === targetKey)
      if (!panel || !pin) {
        setPlacement(null)
        return
      }

      const pinBounds = pin.getBoundingClientRect()
      const canvasBounds = canvas.getBoundingClientRect()
      const next = placeAnnotationThread(
        {
          left: pinBounds.left - canvasBounds.left,
          top: pinBounds.top - canvasBounds.top,
          width: pinBounds.width,
          height: pinBounds.height,
        },
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { left: 0, top: 0, width: canvasBounds.width, height: canvasBounds.height },
      )
      setPlacement((current) => samePlacement(current, next) ? current : next)
    }
    const schedulePlacement = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updatePlacement)
    }

    schedulePlacement()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedulePlacement)
    if (panelRef.current) observer?.observe(panelRef.current)
    observer?.observe(editor.getContainer())
    window.addEventListener('resize', schedulePlacement)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedulePlacement)
    }
  }, [camera, content, editor, targetKey])

  if (!content) return null

  const style: CSSProperties = {
    left: placement?.left ?? 0,
    top: placement?.top ?? 0,
    zIndex,
    visibility: placement ? undefined : 'hidden',
  }
  const preview = mode === 'preview'
  return (
    <div
      ref={panelRef}
      className={`elves-annotation-foreground-item elves-annotation-foreground-item--${mode}`}
      data-testid="annotation-popover"
      data-annotation-popover-target={targetKey}
      style={style}
      onPointerEnter={preview ? () => setAnnotationHover(target) : undefined}
      onPointerLeave={preview ? () => dismissAnnotationPopoverSoon(target) : undefined}
      onFocus={preview ? () => setAnnotationHover(target) : undefined}
      onBlur={preview ? () => dismissAnnotationPopoverSoon(target) : undefined}
    >
      {preview ? (
        <AnnotationThread comment={content.comment} mode="preview" attribution={content.attribution} />
      ) : (
        <AnnotationThread
          comment={content.comment}
          mode="open"
          attribution={content.attribution}
          {...foregroundThreadProps(target)}
        />
      )}
    </div>
  )
}

/** Renders every active annotation above tldraw's shape stack. */
export function AnnotationPopoverLayer() {
  const editor = useEditor()
  const [, setTargetsVersion] = useState(0)
  const [, setPresentationVersion] = useState(0)

  useEffect(() => subscribeAnnotationTargets(() => setTargetsVersion((version) => version + 1)), [])
  useEffect(() => subscribeAnnotationThreadPresentation(() => setPresentationVersion((version) => version + 1)), [])

  const entries = foregroundEntries(annotationOpenTargets(), annotationHoverTarget())
  if (!entries.length) return null

  return (
    <div className="elves-annotation-popover-layer" aria-live="polite">
      {entries.map((entry) => (
        <AnnotationForegroundItem key={annotationTargetKey(entry.target)} {...entry} editor={editor} />
      ))}
    </div>
  )
}
