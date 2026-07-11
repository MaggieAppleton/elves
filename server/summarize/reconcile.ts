import type { ChangeSet, Op } from '../../src/model/changeset'
import {
  SummarizableCard, SummarizableComment, summaryHash, summaryState, commentSummaryState,
} from '../../src/model/summary'
import type { Summarizer } from './summarizer'

/** A card as reconciliation sees it: the summary decision fields plus its id. */
export interface ReconcileCard extends SummarizableCard {
  id: string
}

/** A comment as reconciliation sees it: the summary decision fields plus the
 * ids needed to address it — its own commentId and its owning cardId. */
export interface ReconcileComment extends SummarizableComment {
  cardId: string
  commentId: string
}

/**
 * Decide and produce the summary updates a canvas needs, as a single change-set
 * (author `claude`, `set_summary` ops) that flows through the normal apply +
 * broadcast pipeline so open browsers update live.
 *
 * - `generate` cards are sent to the summarizer; a non-null reply becomes a
 *   set_summary carrying the gist, the source-text hash (for staleness), the
 *   backend label, and a timestamp.
 * - `clear` cards (shortened below the threshold but still carrying a stale
 *   gist) get a set_summary that nulls the summary out.
 *
 * Returns null when there is nothing to do — including when the summarizer is
 * unreachable and yields null for every card, so a missing model is a silent
 * no-op rather than an error.
 */
export async function reconcileSummaries(
  cards: ReconcileCard[],
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const ops: Op[] = []
  for (const card of cards) {
    const state = summaryState(card)
    if (state === 'clear') {
      ops.push({
        kind: 'set_summary', cardId: card.id,
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      })
    } else if (state === 'generate') {
      const summary = await summarizer.summarize(card.text)
      if (summary) {
        ops.push({
          kind: 'set_summary', cardId: card.id,
          summary, summaryOfHash: summaryHash(card.text),
          summaryBy: summarizer.label, summaryAt: now(),
        })
      }
    }
  }
  if (!ops.length) return null
  return { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
}

/**
 * Same reconciliation as reconcileSummaries, one level down: a comment is a
 * first-class summarizable unit too, so it gets the identical generate/clear
 * decision and the same set_comment_summary op, keyed by both its cardId and
 * its own commentId (a card can hold many comments, so cardId alone doesn't
 * address one).
 */
export async function reconcileCommentSummaries(
  comments: ReconcileComment[],
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const ops: Op[] = []
  for (const comment of comments) {
    const state = commentSummaryState(comment)
    if (state === 'clear') {
      ops.push({
        kind: 'set_comment_summary', cardId: comment.cardId, commentId: comment.commentId,
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      })
    } else if (state === 'generate') {
      const summary = await summarizer.summarize(comment.text)
      if (summary) {
        ops.push({
          kind: 'set_comment_summary', cardId: comment.cardId, commentId: comment.commentId,
          summary, summaryOfHash: summaryHash(comment.text),
          summaryBy: summarizer.label, summaryAt: now(),
        })
      }
    }
  }
  if (!ops.length) return null
  return { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
}

/** A question as reconciliation sees it: the summary decision fields plus its
 * own shape id (a question is addressed directly, unlike a comment). */
export interface ReconcileQuestion extends SummarizableComment {
  questionId: string
}

/**
 * Same reconciliation as reconcileCommentSummaries, applied to questions: a
 * question is agent-authored plain text, so it shares the identical
 * generate/clear decision, keyed by its own shape id.
 */
export async function reconcileQuestionSummaries(
  questions: ReconcileQuestion[],
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const ops: Op[] = []
  for (const q of questions) {
    const state = commentSummaryState(q)
    if (state === 'clear') {
      ops.push({
        kind: 'set_question_summary', questionId: q.questionId,
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      })
    } else if (state === 'generate') {
      const summary = await summarizer.summarize(q.text)
      if (summary) {
        ops.push({
          kind: 'set_question_summary', questionId: q.questionId,
          summary, summaryOfHash: summaryHash(q.text),
          summaryBy: summarizer.label, summaryAt: now(),
        })
      }
    }
  }
  if (!ops.length) return null
  return { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
}
