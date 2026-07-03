import type { CardKind, SourceKind } from './types'

/**
 * A card's `summary` is a model-authored one-phrase gist of a long card. This
 * module is the pure decision logic around it — what counts as long enough to
 * summarize, whether an existing summary is stale, and how to derive a readable
 * gist when no model summary exists. It calls no network and touches no shape,
 * so it is trivially unit-testable; the impure Ollama/OpenAI call lives in
 * server/summarize/.
 */

/** The minimal card shape this module reasons about. */
export interface SummarizableCard {
  kind: CardKind
  sourceKind: SourceKind | null
  text: string
  summary: string | null
  summaryOfHash: string | null
}

/** A small, stable, non-cryptographic hash (FNV-1a) rendered in base36. */
export function summaryHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    // FNV prime, kept in 32-bit range via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Text-bearing (prose, or a text source card) with any content at all. Every
 * note and prose card gets a summary regardless of length — at the zoom-out map
 * level even a short card's own text is too small to read, so we give them all a
 * consistent, legible gist. (Image and reference cards are excluded: images have
 * no text, references already carry a description.)
 */
export function isSummarizable(card: SummarizableCard): boolean {
  const textBearing = card.kind === 'prose' || (card.kind === 'source' && card.sourceKind === 'text')
  return textBearing && card.text.trim().length > 0
}

export type SummaryState = 'generate' | 'clear' | 'ok'

/**
 * What reconciliation should do with a card:
 * - `generate` — it's long and has no summary, or its text changed under the summary.
 * - `clear` — it's no longer summarizable (shortened/emptied) but still carries a stale summary.
 * - `ok` — nothing to do.
 */
export function summaryState(card: SummarizableCard): SummaryState {
  if (isSummarizable(card)) {
    if (card.summary === null || card.summaryOfHash !== summaryHash(card.text)) return 'generate'
    return 'ok'
  }
  return card.summary !== null ? 'clear' : 'ok'
}

/**
 * A readable gist derived mechanically from the text — the honest-truncation
 * fallback used on the map and when zoomed out whenever no model summary exists
 * (Ollama off, not yet generated). Prefers a first-sentence cut, else a
 * word-boundary truncation with an ellipsis.
 */
export function mechanicalGist(text: string, max = 120): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  const sentence = t.slice(0, max + 1).match(/^(.*?[.!?])\s/)
  if (sentence && sentence[1].length >= 40) return sentence[1]
  const cut = t.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

/** The gist to display: the model summary if present, else a mechanical one. */
export function cardGist(card: SummarizableCard): string {
  return card.summary ?? mechanicalGist(card.text)
}
