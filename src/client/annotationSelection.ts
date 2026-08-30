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

const listeners = new Set<AnnotationOpenListener>()
const replyListeners = new Set<AnnotationReplyListener>()
const retryListeners = new Set<AnnotationRetryListener>()
const presentationListeners = new Set<() => void>()
const presentations = new Map<string, AnnotationThreadPresentation>()
let annotationReplyLocked = false

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
