import type { CommentType } from './types'

export const PIN_GAP = 8
export const PIN_SIZE = 28

export type AnnotationPinIcon =
  | 'comment' | 'warning' | 'chart-down' | 'link' | 'image'
  | 'arrows' | 'scissors' | 'question' | 'buildings'

export type AnnotationPin = {
  icon: AnnotationPinIcon
  tone: CommentType | 'freeform'
  label: string
}

export type CardAnnotationPin = {
  commentId: string
  offsetY: number
}

const PIN_TOKENS: Record<CommentType | 'freeform', AnnotationPin> = {
  'needs-evidence': { icon: 'warning', tone: 'needs-evidence', label: 'Needs evidence' },
  'weak-argument': { icon: 'chart-down', tone: 'weak-argument', label: 'Weak argument' },
  'needs-citation': { icon: 'link', tone: 'needs-citation', label: 'Needs citation' },
  'wants-figure': { icon: 'image', tone: 'wants-figure', label: 'Wants figure' },
  counterpoint: { icon: 'arrows', tone: 'counterpoint', label: 'Counterpoint' },
  tighten: { icon: 'scissors', tone: 'tighten', label: 'Tighten' },
  unclear: { icon: 'question', tone: 'unclear', label: 'Unclear' },
  structure: { icon: 'buildings', tone: 'structure', label: 'Structure' },
  freeform: { icon: 'comment', tone: 'freeform', label: 'Comment' },
}

/** Return the stable visual and accessible tokens for an annotation type. */
export function annotationPin(type: CommentType | null): AnnotationPin {
  const token = PIN_TOKENS[type ?? 'freeform']
  return { ...token }
}

/** Place one compact pin per comment in source order, with a fixed clear gap. */
export function cardAnnotationPins(
  comments: readonly { id: string }[],
): CardAnnotationPin[] {
  return comments.map((comment, index) => ({
    commentId: comment.id,
    offsetY: index * (PIN_SIZE + PIN_GAP),
  }))
}
