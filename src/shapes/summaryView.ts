import type { NoteKind } from '../model/types'

/**
 * At or below this zoom level a card is small enough that its full text is hard
 * to read, so a summarized card shows its gist instead — the shape of the whole
 * piece (section labels + one-line gists) becomes legible at a glance. tldraw
 * zoom is 1 = 100%, so 0.6 means the gist appears once you zoom out past 60%.
 */
export const GIST_ZOOM = 0.6

/**
 * Whether a card should render its gist rather than its full text right now.
 * Image and reference cards keep their faces. Everything else with a model
 * summary OR non-empty text switches — matching the server's read_map
 * fallback (server/digest.ts), a model summary is shown when present, else a
 * mechanical gist of the text (see `mechanicalGist` in model/summary.ts). A
 * card with neither (empty text, not yet typed into) keeps showing as-is.
 */
export function shouldShowGist(
  zoom: number,
  card: { noteKind: NoteKind | null; summary: string | null; text?: string },
): boolean {
  if (zoom >= GIST_ZOOM) return false
  if (card.noteKind === 'image' || card.noteKind === 'reference') return false
  return !!card.summary || !!card.text?.trim()
}

/**
 * The gist's font size, in card-space px. The whole canvas is scaled by `zoom`,
 * so a fixed size would shrink to nothing as you zoom out — the very moment the
 * gist matters. We counter-scale to hold a roughly constant ON-SCREEN size
 * (`GIST_ON_SCREEN_PX`), clamped so it never gets too small to read or so large
 * it overflows a card. This is a pure function of the zoom, so EVERY gist gets
 * the same size at a given zoom — the summaries read as one consistent set, not
 * a jumble of per-card sizes.
 */
// The on-screen target is set high enough that across the whole gist zoom range
// the counter-scale always wants more than the cap — so every gist lands on
// exactly GIST_FONT_MAX. That gives one uniform size everywhere in gist mode.
export const GIST_ON_SCREEN_PX = 18
// Capped at the largest size that fits a summarized card's box without clipping.
// A card's box is measured to hold the FULL, longer text at 15px, so a short
// gist fits comfortably — measured against the real canvas, 25px clips 0 of 48
// summarized cards while 26px starts cutting a few off.
export const GIST_FONT_MAX = 25
export function gistFontSize(zoom: number): number {
  const compensated = GIST_ON_SCREEN_PX / Math.max(zoom, 0.01)
  return Math.round(Math.min(compensated, GIST_FONT_MAX))
}

/**
 * The gist comment-tag chip's font size, in card-space px. Zoomed out, a
 * summarized card hides its full comments but keeps a small type chip
 * ("WEAK-ARGUMENT" etc.) so the marginalia is still legible at a glance. We
 * derive it straight from the gist size (a fixed ratio) rather than a second
 * counter-scale curve, so the chip and the gist line stay visually paired at
 * every zoom and share the gist's already-tuned cap — one source of truth.
 */
export const GIST_TAG_RATIO = 0.55
export function gistTagFontSize(zoom: number): number {
  return Math.round(gistFontSize(zoom) * GIST_TAG_RATIO)
}
