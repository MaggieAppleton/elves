export type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

export interface AnnotationThreadPresentation {
  running: boolean
  streamingText?: string
  error?: string | null
}

type AnnotationReplyListener = (target: AnnotationTarget, text: string) => void
type AnnotationRetryListener = (target: AnnotationTarget) => void
type AnnotationActionListener = (target: AnnotationTarget) => void
type AnnotationPopoverListener = () => void
type AnnotationTargetListener = () => void

const replyListeners = new Set<AnnotationReplyListener>()
const retryListeners = new Set<AnnotationRetryListener>()
const resolveListeners = new Set<AnnotationActionListener>()
const presentationListeners = new Set<() => void>()
const popoverListeners = new Set<AnnotationPopoverListener>()
const presentations = new Map<string, AnnotationThreadPresentation>()
const openTargets = new Map<string, AnnotationTarget>()
const targetListeners = new Set<AnnotationTargetListener>()
let annotationReplyLocked = false
let activeAnnotationPopover: AnnotationTarget | null = null
let popoverDismissTimer: ReturnType<typeof setTimeout> | null = null
let hoverTarget: AnnotationTarget | null = null

export function annotationTargetKey(target: AnnotationTarget): string {
  return target.kind === 'card'
    ? `card:${target.cardId}:${target.commentId}`
    : `feedback:${target.feedbackId}`
}

export function requestAnnotationOpen(target: AnnotationTarget): void {
  if (openTargets.has(annotationTargetKey(target))) promoteAnnotationThread(target)
  else openAnnotationThread(target)
}

function emitTargets(): void {
  targetListeners.forEach((listener) => listener())
}

export function annotationOpenTargets(): AnnotationTarget[] {
  return Array.from(openTargets.values())
}

export function annotationHoverTarget(): AnnotationTarget | null {
  return hoverTarget
}

export function subscribeAnnotationTargets(listener: AnnotationTargetListener): () => void {
  targetListeners.add(listener)
  return () => targetListeners.delete(listener)
}

export function openAnnotationThread(target: AnnotationTarget): void {
  const key = annotationTargetKey(target)
  if (openTargets.has(key)) return
  openTargets.set(key, target)
  if (hoverTarget && annotationTargetKey(hoverTarget) === key) hoverTarget = null
  emitTargets()
}

export function promoteAnnotationThread(target: AnnotationTarget): void {
  const key = annotationTargetKey(target)
  const current = openTargets.get(key)
  if (!current) return
  openTargets.delete(key)
  openTargets.set(key, current)
  if (hoverTarget && annotationTargetKey(hoverTarget) === key) hoverTarget = null
  emitTargets()
}

export function closeAnnotationThread(target: AnnotationTarget): void {
  if (!openTargets.delete(annotationTargetKey(target))) return
  emitTargets()
}

export function requestAnnotationClose(target: AnnotationTarget): void {
  closeAnnotationThread(target)
}

export function subscribeAnnotationResolve(listener: AnnotationActionListener): () => void {
  resolveListeners.add(listener)
  return () => resolveListeners.delete(listener)
}

export function requestAnnotationResolve(target: AnnotationTarget): void {
  resolveListeners.forEach((listener) => listener(target))
}

/** Remove stale presentation state without changing any canvas records. */
export function pruneAnnotationThreads(isOpenTarget: (target: AnnotationTarget) => boolean): void {
  let changed = false
  for (const [key, target] of openTargets) {
    if (!isOpenTarget(target)) {
      openTargets.delete(key)
      changed = true
    }
  }
  if (changed) emitTargets()
}

export function setAnnotationHover(target: AnnotationTarget | null): void {
  if (target && popoverDismissTimer !== null) {
    clearTimeout(popoverDismissTimer)
    popoverDismissTimer = null
  }
  hoverTarget = target && openTargets.has(annotationTargetKey(target)) ? null : target
  emitTargets()
}

/** Clear all ephemeral annotation state; none of this belongs in a canvas snapshot. */
export function clearAnnotationPresentations(): void {
  openTargets.clear()
  hoverTarget = null
  clearAnnotationPopover()
  clearAnnotationThreadPresentations()
  emitTargets()
}

export function subscribeAnnotationReply(listener: AnnotationReplyListener): () => void {
  replyListeners.add(listener)
  return () => replyListeners.delete(listener)
}

export function requestAnnotationReply(target: AnnotationTarget, text: string): void {
  replyListeners.forEach((listener) => listener(target, text))
}

export function subscribeAnnotationRetry(listener: AnnotationRetryListener): () => void {
  retryListeners.add(listener)
  return () => retryListeners.delete(listener)
}

export function requestAnnotationRetry(target: AnnotationTarget): void {
  retryListeners.forEach((listener) => listener(target))
}

export function annotationThreadPresentation(target: AnnotationTarget): AnnotationThreadPresentation | undefined {
  return presentations.get(annotationTargetKey(target))
}

export function setAnnotationThreadPresentation(
  target: AnnotationTarget,
  presentation: AnnotationThreadPresentation | null,
): void {
  const key = annotationTargetKey(target)
  if (presentation) presentations.set(key, presentation)
  else presentations.delete(key)
  presentationListeners.forEach((listener) => listener())
}

/** Project changes invalidate every shape-local presentation immediately. */
export function clearAnnotationThreadPresentations(): void {
  if (!presentations.size) return
  presentations.clear()
  presentationListeners.forEach((listener) => listener())
}

/** The expanded thread is rendered once in tldraw's front-of-canvas layer.
 * Shape-local z-indexes cannot rise above a sibling shape's transformed layer. */
export function annotationPopover(): AnnotationTarget | null { return activeAnnotationPopover }
export function showAnnotationPopover(target: AnnotationTarget): void {
  if (popoverDismissTimer !== null) {
    clearTimeout(popoverDismissTimer)
    popoverDismissTimer = null
  }
  if (activeAnnotationPopover && annotationTargetKey(activeAnnotationPopover) === annotationTargetKey(target)) return
  activeAnnotationPopover = target
  popoverListeners.forEach((listener) => listener())
}

export function hideAnnotationPopover(target?: AnnotationTarget): void {
  if (!activeAnnotationPopover || (target && annotationTargetKey(activeAnnotationPopover) !== annotationTargetKey(target))) return
  if (popoverDismissTimer !== null) {
    clearTimeout(popoverDismissTimer)
    popoverDismissTimer = null
  }
  activeAnnotationPopover = null
  popoverListeners.forEach((listener) => listener())
}

/** Keep the expanded popover interactive when focus or the pointer leaves its pin. */
export function dismissAnnotationPopoverSoon(target: AnnotationTarget): void {
  const targetKey = annotationTargetKey(target)
  const dismissesPopover = activeAnnotationPopover && annotationTargetKey(activeAnnotationPopover) === targetKey
  const dismissesHover = hoverTarget && annotationTargetKey(hoverTarget) === targetKey
  if (!dismissesPopover && !dismissesHover) return
  if (popoverDismissTimer !== null) clearTimeout(popoverDismissTimer)
  popoverDismissTimer = setTimeout(() => {
    popoverDismissTimer = null
    hideAnnotationPopover(target)
    if (hoverTarget && annotationTargetKey(hoverTarget) === targetKey) {
      hoverTarget = null
      emitTargets()
    }
  }, 100)
}

export function clearAnnotationPopover(): void { hideAnnotationPopover() }

export function subscribeAnnotationPopover(listener: AnnotationPopoverListener): () => void {
  popoverListeners.add(listener)
  return () => popoverListeners.delete(listener)
}

export function subscribeAnnotationThreadPresentation(listener: () => void): () => void {
  presentationListeners.add(listener)
  return () => presentationListeners.delete(listener)
}

export function annotationRepliesLocked(): boolean { return annotationReplyLocked }
export function setAnnotationRepliesLocked(locked: boolean): void {
  if (annotationReplyLocked === locked) return
  annotationReplyLocked = locked
  presentationListeners.forEach((listener) => listener())
}
