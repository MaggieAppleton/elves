import type { SourceKind } from '../model/types'

/**
 * Below this zoom level a card is too small to read in full, so a summarized
 * card shows its gist instead — the shape of the whole piece (section labels +
 * one-line gists) becomes legible at a glance. tldraw zoom is 1 = 100%.
 */
export const GIST_ZOOM = 0.5

/**
 * Whether a card should render its gist rather than its full text right now.
 * Only text cards with an actual model summary switch — image and reference
 * cards keep their faces, and a card with no summary (short, or not yet
 * generated) keeps showing its own text.
 */
export function shouldShowGist(
  zoom: number,
  card: { sourceKind: SourceKind | null; summary: string | null },
): boolean {
  if (zoom >= GIST_ZOOM) return false
  if (card.sourceKind === 'image' || card.sourceKind === 'reference') return false
  return !!card.summary
}
