import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { useEditor, useValue, type Editor, type TLShapeId } from 'tldraw'
import {
  annotationThreadMaxHeight,
  arrangeAnnotationThreads,
  type AnnotationPlacement,
  type AnnotationRect,
  type AnnotationViewport,
} from '../client/annotationPlacement'
import {
  annotationClosingTargets, annotationHoverOrigin, annotationHoverTarget, annotationOpenOrigin,
  annotationOpenTargets, annotationRepliesLocked, annotationReplyDraft, annotationResolutionCues, annotationTargetKey,
  annotationThreadPresentation, dismissAnnotationPopoverSoon, pruneAnnotationThreads,
  requestAnnotationClose, requestAnnotationOpen, requestAnnotationReply, requestAnnotationResolutionUndo,
  requestAnnotationResolve, requestAnnotationRetry, clearAnnotationReplyDraft, clearAnnotationResolutionCue,
  setAnnotationHover, setAnnotationReplyDraft,
  subscribeAnnotationTargets, subscribeAnnotationThreadPresentation, suppressNextAnnotationFocus,
  type AnnotationInteractionOrigin, type AnnotationResolutionCue, type AnnotationTarget, type ClosingAnnotationTarget,
} from '../client/annotationSelection'
import { prefersReducedMotion } from '../client/motion'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { FeedbackShape } from '../shapes/FeedbackShapeUtil'
import { AnnotationThread, type AnnotationThreadComment, type AnnotationThreadProps } from './AnnotationThread'

type PopoverContent = { comment: AnnotationThreadComment; attribution?: string }

export type ForegroundEntry = {
  target: AnnotationTarget
  mode: 'preview' | 'open' | 'closing'
  origin: AnnotationInteractionOrigin
  zIndex: number
}

export function annotationPopoverMotion(
  mode: ForegroundEntry['mode'],
  origin: AnnotationInteractionOrigin,
  placementReady: boolean,
  entranceReady: boolean,
): 'pending' | 'enter' | 'exit' | undefined {
  if (mode === 'closing') return 'exit'
  if (origin !== 'pointer') return undefined
  return placementReady && entranceReady ? 'enter' : 'pending'
}

const RESOLUTION_CUE_MS = 4_000

export function ResolvedAnnotationCue({ cue }: { cue: AnnotationResolutionCue }) {
  const remaining = useRef(RESOLUTION_CUE_MS)
  const cueRef = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const [focusInside, setFocusInside] = useState(false)
  const [position, setPosition] = useState({ left: cue.anchor.left, top: cue.anchor.top })

  useLayoutEffect(() => {
    const element = cueRef.current
    const boundary = element?.parentElement
    if (!element || !boundary) return
    const place = () => {
      const desiredLeft = cue.anchor.side === 'left'
        ? cue.anchor.left - element.offsetWidth
        : cue.anchor.left
      const left = Math.max(8, Math.min(desiredLeft, boundary.clientWidth - element.offsetWidth - 8))
      const top = Math.max(8, Math.min(cue.anchor.top, boundary.clientHeight - element.offsetHeight - 8))
      setPosition((current) => current.left === left && current.top === top ? current : { left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(boundary)
    return () => observer.disconnect()
  }, [cue.anchor.left, cue.anchor.side, cue.anchor.top])

  useEffect(() => {
    if (pointerInside || focusInside) return
    const started = Date.now()
    const timer = setTimeout(() => clearAnnotationResolutionCue(cue), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [focusInside, pointerInside])

  return (
    <div
      ref={cueRef}
      className="elves-annotation-resolved-cue"
      data-side={cue.anchor.side}
      data-testid="annotation-resolved-cue"
      style={position}
      onPointerDown={stopForegroundEvent}
      onClick={stopForegroundEvent}
      onKeyDown={stopForegroundEvent}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false)
      }}
    >
      <span role="status">Comment resolved</span>
      <button
        type="button"
        disabled={annotationRepliesLocked()}
        onClick={() => {
          if (!annotationRepliesLocked()) requestAnnotationResolutionUndo(cue)
        }}
      >
        Undo
      </button>
    </div>
  )
}

/** Ordered canvas overlays: promoted threads stay on top, with one hover preview. */
export function foregroundEntries(
  open: AnnotationTarget[],
  hovered: AnnotationTarget | null = null,
  closing: ClosingAnnotationTarget[] = [],
): ForegroundEntry[] {
  const entries: ForegroundEntry[] = []
  if (hovered && !open.some((target) => annotationTargetKey(target) === annotationTargetKey(hovered))) {
    entries.push({ target: hovered, mode: 'preview', origin: annotationHoverOrigin(), zIndex: open.length + 1 })
  }
  open.forEach((target, index) => entries.push({
    target, mode: 'open', origin: annotationOpenOrigin(target), zIndex: index + 1,
  }))
  closing
    .filter(({ target }) => {
      const key = annotationTargetKey(target)
      return !open.some((openTarget) => annotationTargetKey(openTarget) === key) &&
        (!hovered || annotationTargetKey(hovered) !== key)
    })
    .forEach(({ target, origin }, index) => entries.push({ target, mode: 'closing', origin, zIndex: open.length + index + 1 }))
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

interface RememberedPlacement {
  placement: AnnotationPlacement
  anchor: AnnotationRect
  source: AnnotationRect
  mode: ForegroundEntry['mode']
  preserveWhileAnchored: boolean
}

function sameRect(a: AnnotationRect, b: AnnotationRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

function visibleAnnotationPinObstacles(canvas: HTMLElement): AnnotationRect[] {
  const canvasBounds = canvas.getBoundingClientRect()
  return [...canvas.querySelectorAll<HTMLElement>('[data-annotation-target]')].flatMap((pin) => {
    const bounds = pin.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0 ? [{
      left: bounds.left - canvasBounds.left,
      top: bounds.top - canvasBounds.top,
      width: bounds.width,
      height: bounds.height,
    }] : []
  })
}

function sameGeometry(a: ForegroundGeometry | undefined, b: ForegroundGeometry): boolean {
  return !!a && sameRect(a.anchor, b.anchor) && sameRect(a.source, b.source) &&
    a.thread.width === b.thread.width && a.thread.height === b.thread.height &&
    sameRect(a.viewport, b.viewport)
}

interface AnnotationForegroundItemProps {
  target: AnnotationTarget
  mode: ForegroundEntry['mode']
  origin: AnnotationInteractionOrigin
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
  'running' | 'phase' | 'replyMessageId' | 'streamingText' | 'error' | 'disabled' | 'draft' |
  'onDraftChange' | 'onDiscardDraft' | 'onReply' | 'onRetry' | 'onResolve' | 'onClose'
> {
  const presentation = annotationThreadPresentation(target)
  return {
    running: presentation?.running,
    phase: presentation?.phase,
    replyMessageId: presentation?.replyMessageId,
    streamingText: presentation?.streamingText,
    error: presentation?.error,
    draft: annotationReplyDraft(target),
    disabled: annotationRepliesLocked(),
    onReply: (text) => requestAnnotationReply(target, text),
    onDraftChange: (text) => setAnnotationReplyDraft(target, text),
    onDiscardDraft: () => clearAnnotationReplyDraft(target),
    onRetry: () => requestAnnotationRetry(target),
    onResolve: () => requestAnnotationResolve(target),
    onClose: (origin = 'keyboard') => {
      requestAnnotationClose(
        target,
        origin === 'pointer' && !prefersReducedMotion() ? 'pointer' : 'keyboard',
      )
      requestAnimationFrame(() => {
        const key = annotationTargetKey(target)
        const pin = [...document.querySelectorAll<HTMLElement>('[data-annotation-target]')]
          .find((element) => element.dataset.annotationTarget === key)
        if (origin !== 'keyboard') suppressNextAnnotationFocus(target)
        pin?.focus()
      })
    },
  }
}

function AnnotationForegroundItem({
  target, mode, origin, zIndex, editor, placement, onGeometry,
}: AnnotationForegroundItemProps) {
  const targetKey = annotationTargetKey(target)
  const panelRef = useRef<HTMLDivElement>(null)
  const [stageMaxHeight, setStageMaxHeight] = useState<number | null>(null)
  const entered = useRef(false)
  const [entranceReady, setEntranceReady] = useState(false)
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

  useLayoutEffect(() => {
    if (!placement || origin !== 'pointer' || mode === 'closing' || entered.current) return
    entered.current = true
    setEntranceReady(true)
  }, [mode, origin, placement])

  if (!content) return null

  const style: CSSProperties = {
    left: placement?.left ?? 0,
    top: placement?.top ?? 0,
    zIndex,
    visibility: placement ? undefined : 'hidden',
  }
  const preview = mode === 'preview'
  const closing = mode === 'closing'
  const motion = annotationPopoverMotion(mode, origin, !!placement, entranceReady)
  return (
    <div
      ref={panelRef}
      className={`elves-annotation-foreground-item elves-annotation-foreground-item--${mode}`}
      data-testid="annotation-popover"
      data-annotation-popover-target={targetKey}
      data-motion={motion}
      data-placement-side={placement?.side}
      aria-hidden={closing || undefined}
      style={style}
      onPointerDown={closing ? undefined : stopForegroundEvent}
      onClick={closing ? undefined : preview ? (event) => {
        stopForegroundEvent(event)
        requestAnnotationOpen(target, 'pointer')
      } : stopForegroundEvent}
      onKeyDown={closing ? undefined : stopForegroundEvent}
      onPointerEnter={preview ? () => setAnnotationHover(target, 'pointer') : undefined}
      onPointerLeave={preview ? () => dismissAnnotationPopoverSoon(target) : undefined}
      onFocus={preview ? () => setAnnotationHover(target, 'keyboard') : undefined}
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
          {...(closing ? {} : foregroundThreadProps(target))}
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
  const rememberedPlacements = useRef(new Map<string, RememberedPlacement>())

  useEffect(() => subscribeAnnotationTargets(() => setTargetsVersion((version) => version + 1)), [])
  useEffect(() => subscribeAnnotationThreadPresentation(() => setPresentationVersion((version) => version + 1)), [])

  const entries = foregroundEntries(annotationOpenTargets(), annotationHoverTarget(), annotationClosingTargets())
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
      const remembered = rememberedPlacements.current.get(key)
      return geometry ? [{
        key,
        anchor: geometry.anchor,
        source: geometry.source,
        thread: geometry.thread,
        preferredSide: remembered?.placement.side,
        preservePlacement: remembered && (remembered.preserveWhileAnchored ||
          (remembered.mode === 'preview' && entry.mode === 'open')) &&
          sameRect(remembered.anchor, geometry.anchor) && sameRect(remembered.source, geometry.source)
          ? remembered.placement
          : undefined,
      }] : []
    })
    const viewport = priority.map((entry) => geometries[annotationTargetKey(entry.target)]?.viewport)
      .find((value): value is AnnotationViewport => !!value)
    if (!viewport) return {}
    const arranged = arrangeAnnotationThreads(items, viewport, {
      pinObstacles: visibleAnnotationPinObstacles(editor.getContainer()),
    })
    for (const item of items) {
      const previous = rememberedPlacements.current.get(item.key)
      const anchorsMatch = previous && sameRect(previous.anchor, item.anchor) && sameRect(previous.source, item.source)
      rememberedPlacements.current.set(item.key, {
        placement: arranged[item.key],
        anchor: item.anchor,
        source: item.source,
        mode: priority.find((entry) => annotationTargetKey(entry.target) === item.key)!.mode,
        preserveWhileAnchored: !!anchorsMatch && (previous?.preserveWhileAnchored ||
          (previous?.mode === 'preview' && priority.find((entry) => annotationTargetKey(entry.target) === item.key)!.mode === 'open')),
      })
    }
    return arranged
  }, [entries, geometries])
  const resolvedCues = annotationResolutionCues()
  if (!entries.length && !resolvedCues.length) return null

  return (
    <div className="elves-annotation-popover-layer">
      {entries.map((entry) => (
        <AnnotationForegroundItem
          key={annotationTargetKey(entry.target)}
          {...entry}
          editor={editor}
          placement={placements[annotationTargetKey(entry.target)]}
          onGeometry={reportGeometry}
        />
      ))}
      {resolvedCues.map((cue) => <ResolvedAnnotationCue key={cue.id} cue={cue} />)}
    </div>
  )
}
