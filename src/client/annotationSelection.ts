export type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

export interface AnnotationThreadPresentation {
  running: boolean
  streamingText?: string
  error?: string | null
}

type AnnotationOpenListener = (target: AnnotationTarget) => void
type AnnotationReplyListener = (target: AnnotationTarget, text: string) => void
type AnnotationRetryListener = (target: AnnotationTarget) => void
type AnnotationPopoverListener = () => void

const listeners = new Set<AnnotationOpenListener>()
const replyListeners = new Set<AnnotationReplyListener>()
const retryListeners = new Set<AnnotationRetryListener>()
const presentationListeners = new Set<() => void>()
const popoverListeners = new Set<AnnotationPopoverListener>()
const presentations = new Map<string, AnnotationThreadPresentation>()
let annotationReplyLocked = false
let activeAnnotationPopover: AnnotationTarget | null = null
let popoverDismissTimer: ReturnType<typeof setTimeout> | null = null

export function annotationTargetKey(target: AnnotationTarget): string {
  return target.kind === 'card'
    ? `card:${target.cardId}:${target.commentId}`
    : `feedback:${target.feedbackId}`
}

export function subscribeAnnotationOpen(listener: AnnotationOpenListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function requestAnnotationOpen(target: AnnotationTarget): void {
  listeners.forEach((listener) => listener(target))
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
  if (!activeAnnotationPopover || annotationTargetKey(activeAnnotationPopover) !== annotationTargetKey(target)) return
  if (popoverDismissTimer !== null) clearTimeout(popoverDismissTimer)
  popoverDismissTimer = setTimeout(() => hideAnnotationPopover(target), 100)
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
