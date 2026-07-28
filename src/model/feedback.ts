import type { CommentType } from './types'
import { CARD_DEFAULT_W } from './types'

export interface FeedbackProps {
  w: number
  h: number
  text: string
  authoredBy: string
  type: CommentType | null
  reviewId: string | null
  reviewer: string | null
  resolved: boolean
}

export const FEEDBACK_DEFAULT_W = CARD_DEFAULT_W
export const FEEDBACK_DEFAULT_H = 96

export function makeFeedbackProps(
  text = '', authoredBy = 'claude',
  metadata: Partial<Pick<FeedbackProps, 'type' | 'reviewId' | 'reviewer'>> = {},
): FeedbackProps {
  return {
    w: FEEDBACK_DEFAULT_W, h: FEEDBACK_DEFAULT_H, text, authoredBy,
    type: metadata.type ?? null, reviewId: metadata.reviewId ?? null,
    reviewer: metadata.reviewer ?? null, resolved: false,
  }
}
