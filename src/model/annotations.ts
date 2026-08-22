import type { FeedbackProps } from './feedback'
import { commentGist, mechanicalGist } from './summary'
import type { Comment, CommentType } from './types'
import { GIST_ZOOM } from '../shapes/summaryView'

export type AnnotationMarker = {
  type: CommentType | null
  label: string
  count: number
}

export function annotationDisplayMode(zoom: number): 'detail' | 'overview' {
  return zoom <= GIST_ZOOM ? 'overview' : 'detail'
}

export function attachedAnnotationMarker(comments: Comment[]): AnnotationMarker | null {
  const open = comments.filter((comment) => !comment.resolved)
  if (!open.length) return null
  return {
    type: open[0].type,
    label: mechanicalGist(commentGist(open[0]), 48),
    count: open.length,
  }
}

export function feedbackAnnotationMarker(
  feedback: Pick<FeedbackProps, 'text' | 'type' | 'resolved'>,
): AnnotationMarker | null {
  if (feedback.resolved) return null
  return { type: feedback.type, label: mechanicalGist(feedback.text, 48), count: 1 }
}
