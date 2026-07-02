import type { Editor } from 'tldraw'

/**
 * Text auto-sizing for cards and section headers.
 *
 * Cards are created at a fixed default size, but hold wildly different amounts
 * of text — so most were clipped until hand-resized. Rather than bake per-card
 * sizes into the saved canvas (which the running app overwrites on its next
 * autosave), we measure the text here, in the shape, and grow the box to fit.
 * The measurement uses tldraw's own text-measurement DOM, so it matches how the
 * text actually wraps at the card's font/width.
 */

// Must match the card/section CSS font stack (see theme.css: --elves-card-font).
const FONT_FAMILY = "'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif"

// --- Cards ---------------------------------------------------------------
// card.css: font 15px / line-height 1.45; padding 12px (top/bottom) 14px (l/r).
// A source card also carries a "NOTE" badge row (badge + 6px flex gap) above
// the text; prose cards don't.
const CARD_PAD_X = 28 // 14 left + 14 right
const CARD_PAD_Y = 24 // 12 top + 12 bottom
const CARD_BADGE_ROW = 20 // NOTE badge line + gap (source cards only)

export function measuredCardHeight(
  editor: Editor,
  text: string,
  width: number,
  hasBadge: boolean,
): number {
  const { h } = editor.textMeasure.measureText(text || ' ', {
    fontFamily: FONT_FAMILY,
    fontSize: 15,
    lineHeight: 1.45,
    fontWeight: '400',
    fontStyle: 'normal',
    maxWidth: Math.max(40, width - CARD_PAD_X),
    padding: '0px',
  })
  return Math.ceil(h + CARD_PAD_Y + (hasBadge ? CARD_BADGE_ROW : 0))
}

// --- Section headers -----------------------------------------------------
// section.css: font 56px bold / line-height 1.15; no padding. A long label
// should wrap to about two lines, never three.
const SECTION_ONE_LINE_MAX = 520 // above this single-line width, wrap to two lines

export function measuredSectionSize(
  editor: Editor,
  text: string,
  currentWidth: number,
  fitWidth: boolean,
): { w: number; h: number } {
  const base = {
    fontFamily: FONT_FAMILY,
    fontSize: 56,
    lineHeight: 1.15,
    fontWeight: '700',
    fontStyle: 'normal',
    padding: '0px',
  } as const

  let width = currentWidth
  if (fitWidth) {
    const single = editor.textMeasure.measureText(text || ' ', { ...base, maxWidth: null })
    width =
      single.w > SECTION_ONE_LINE_MAX
        ? Math.ceil(single.w / 2) + 40 // aim for ~two lines
        : Math.ceil(single.w) + 8
  }
  const { h } = editor.textMeasure.measureText(text || ' ', { ...base, maxWidth: width })
  return { w: Math.ceil(width), h: Math.ceil(h) + 8 }
}
