export type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

type AnnotationOpenListener = (target: AnnotationTarget) => void
type AnnotationReplyListener = (target: AnnotationTarget, text: string) => void

const listeners = new Set<AnnotationOpenListener>()
const replyListeners = new Set<AnnotationReplyListener>()

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
