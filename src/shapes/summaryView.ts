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

/**
 * The gist's font size, in card-space px. The whole canvas is scaled by `zoom`,
 * so a fixed size would shrink to nothing as you zoom out — the very moment the
 * gist matters. We counter-scale to hold a roughly constant ON-SCREEN size
 * (`GIST_ON_SCREEN_PX`), clamped so it never gets too small to read or so large
 * it overflows a card. This is what keeps the gist legible like a map label.
 */
export const GIST_ON_SCREEN_PX = 18
export const GIST_FONT_MIN = 30
export const GIST_FONT_MAX = 56
export function gistFontSize(zoom: number): number {
  const compensated = GIST_ON_SCREEN_PX / Math.max(zoom, 0.01)
  return Math.round(Math.min(Math.max(compensated, GIST_FONT_MIN), GIST_FONT_MAX))
}
