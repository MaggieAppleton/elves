import type { ChangeSet, Op } from '../../src/model/changeset'
import { SummarizableCard, summaryHash, summaryState } from '../../src/model/summary'
import type { Summarizer } from './summarizer'

/** A card as reconciliation sees it: the summary decision fields plus its id. */
export interface ReconcileCard extends SummarizableCard {
  id: string
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
