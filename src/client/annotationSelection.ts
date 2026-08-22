export type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

type AnnotationOpenListener = (target: AnnotationTarget) => void

const listeners = new Set<AnnotationOpenListener>()

export function subscribeAnnotationOpen(listener: AnnotationOpenListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function requestAnnotationOpen(target: AnnotationTarget): void {
  listeners.forEach((listener) => listener(target))
}
