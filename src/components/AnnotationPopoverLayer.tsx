import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { useEditor, useValue, type Editor, type TLShapeId } from 'tldraw'
import {
  annotationThreadMaxHeight,
  arrangeAnnotationThreads,
  type AnnotationPlacement,
  type AnnotationRect,
  type AnnotationViewport,
} from '../client/annotationPlacement'
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

interface ForegroundGeometry {
  anchor: AnnotationRect
  source: AnnotationRect
  thread: Pick<AnnotationRect, 'width' | 'height'>
  viewport: AnnotationViewport
}

function sameRect(a: AnnotationRect, b: AnnotationRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

function sameGeometry(a: ForegroundGeometry | undefined, b: ForegroundGeometry): boolean {
  return !!a && sameRect(a.anchor, b.anchor) && sameRect(a.source, b.source) &&
    a.thread.width === b.thread.width && a.thread.height === b.thread.height &&
    sameRect(a.viewport, b.viewport)
}

interface AnnotationForegroundItemProps {
  target: AnnotationTarget
  mode: ForegroundEntry['mode']
  zIndex: number
  editor: Editor
  placement?: AnnotationPlacement
  onGeometry(targetKey: string, geometry: ForegroundGeometry | null): void
}

function stopForegroundEvent(event: SyntheticEvent): void {
  event.stopPropagation()
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

function AnnotationForegroundItem({
  target, mode, zIndex, editor, placement, onGeometry,
}: AnnotationForegroundItemProps) {
  const targetKey = annotationTargetKey(target)
  const panelRef = useRef<HTMLDivElement>(null)
  const [stageMaxHeight, setStageMaxHeight] = useState<number | null>(null)
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
      onGeometry(targetKey, null)
      return
    }

    let frame: number | null = null
    const updatePlacement = () => {
      frame = null
      const panel = panelRef.current
      const canvas = editor.getContainer()
      const canvasBounds = canvas.getBoundingClientRect()
      const nextMaxHeight = annotationThreadMaxHeight(canvasBounds.height)
      setStageMaxHeight((current) => current === nextMaxHeight ? current : nextMaxHeight)
      const pin = [...canvas.querySelectorAll<HTMLElement>('[data-annotation-target]')]
        .find((element) => element.dataset.annotationTarget === targetKey)
      if (!panel || !pin) {
        onGeometry(targetKey, null)
        return
      }

      const pinBounds = pin.getBoundingClientRect()
      const host = pin.closest<HTMLElement>('[data-shape-id]') ?? pin
      const hostBounds = host.getBoundingClientRect()
      onGeometry(targetKey, {
        anchor: {
          left: pinBounds.left - canvasBounds.left,
          top: pinBounds.top - canvasBounds.top,
          width: pinBounds.width,
          height: pinBounds.height,
        },
        source: {
          left: hostBounds.left - canvasBounds.left,
          top: hostBounds.top - canvasBounds.top,
          width: hostBounds.width,
          height: hostBounds.height,
        },
        thread: { width: panel.offsetWidth, height: panel.offsetHeight },
        viewport: { left: 0, top: 0, width: canvasBounds.width, height: canvasBounds.height },
      })
    }
    const schedulePlacement = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updatePlacement)
    }

    schedulePlacement()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedulePlacement)
    if (panelRef.current) observer?.observe(panelRef.current)
    observer?.observe(editor.getContainer())
    const pin = [...editor.getContainer().querySelectorAll<HTMLElement>('[data-annotation-target]')]
      .find((element) => element.dataset.annotationTarget === targetKey)
    const host = pin?.closest<HTMLElement>('[data-shape-id]')
    if (host) observer?.observe(host)
    window.addEventListener('resize', schedulePlacement)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedulePlacement)
    }
  }, [camera, content, editor, onGeometry, targetKey])

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
      onPointerDown={stopForegroundEvent}
      onClick={stopForegroundEvent}
      onKeyDown={stopForegroundEvent}
      onPointerEnter={preview ? () => setAnnotationHover(target) : undefined}
      onPointerLeave={preview ? () => dismissAnnotationPopoverSoon(target) : undefined}
      onFocus={preview ? () => setAnnotationHover(target) : undefined}
      onBlur={preview ? () => dismissAnnotationPopoverSoon(target) : undefined}
    >
      {preview ? (
        <AnnotationThread
          comment={content.comment}
          mode="preview"
          attribution={content.attribution}
          maxHeight={stageMaxHeight ?? undefined}
        />
      ) : (
        <AnnotationThread
          comment={content.comment}
          mode="open"
          attribution={content.attribution}
          maxHeight={stageMaxHeight ?? undefined}
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
  const [geometries, setGeometries] = useState<Record<string, ForegroundGeometry>>({})
  const preferredSides = useRef(new Map<string, AnnotationPlacement['side']>())

  useEffect(() => subscribeAnnotationTargets(() => setTargetsVersion((version) => version + 1)), [])
  useEffect(() => subscribeAnnotationThreadPresentation(() => setPresentationVersion((version) => version + 1)), [])

  const entries = foregroundEntries(annotationOpenTargets(), annotationHoverTarget())
  const reportGeometry = useCallback((targetKey: string, geometry: ForegroundGeometry | null) => {
    setGeometries((current) => {
      if (!geometry) {
        if (!current[targetKey]) return current
        const next = { ...current }
        delete next[targetKey]
        return next
      }
      return sameGeometry(current[targetKey], geometry) ? current : { ...current, [targetKey]: geometry }
    })
  }, [])
  const placements = useMemo(() => {
    const priority = [...entries].sort((left, right) => right.zIndex - left.zIndex)
    const items = priority.flatMap((entry) => {
      const key = annotationTargetKey(entry.target)
      const geometry = geometries[key]
      return geometry ? [{
        key,
        anchor: geometry.anchor,
        source: geometry.source,
        thread: geometry.thread,
        preferredSide: preferredSides.current.get(key),
      }] : []
    })
    const viewport = priority.map((entry) => geometries[annotationTargetKey(entry.target)]?.viewport)
      .find((value): value is AnnotationViewport => !!value)
    if (!viewport) return {}
    const arranged = arrangeAnnotationThreads(items, viewport)
    for (const [key, placement] of Object.entries(arranged)) preferredSides.current.set(key, placement.side)
    return arranged
  }, [entries, geometries])
  if (!entries.length) return null

  return (
    <div className="elves-annotation-popover-layer" aria-live="polite">
      {entries.map((entry) => (
        <AnnotationForegroundItem
          key={annotationTargetKey(entry.target)}
          {...entry}
          editor={editor}
          placement={placements[annotationTargetKey(entry.target)]}
          onGeometry={reportGeometry}
        />
      ))}
    </div>
  )
}
