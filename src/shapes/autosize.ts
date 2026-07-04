import type { Editor } from 'tldraw'
import type { Reference } from '../model/types'
import { refMeta, refDescription, refTitle, hasLeftMedia } from '../model/references'

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
// A note card also carries a "NOTE" badge row (badge + 6px flex gap) above
// the text; prose cards don't.
const CARD_PAD_X = 28 // 14 left + 14 right
const CARD_PAD_Y = 24 // 12 top + 12 bottom
const CARD_BADGE_ROW = 20 // NOTE badge line + gap (note cards only)

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

// --- Reference cards -----------------------------------------------------
// card.css .elves-card--reference: padding 13px; a title (15px/600, 1.3,
// clamped to 2 lines), an optional meta row and a 2-line description (13px,
// 1.4), under a fixed eyebrow row. Social/book cards also carry a 46px left
// media thumbnail, so the card is never shorter than that.
const REF_PAD = 26 // 13 left + 13 right (and 13 top + 13 bottom vertically)
const REF_PAD_Y = 26
const REF_EYEBROW = 18 // favicon/glyph row + its gap
const REF_GAP = 5
const REF_MEDIA = 46
const REF_MEDIA_GAP = 10

function clampLines(measuredH: number, fontSize: number, lineHeight: number, maxLines: number): number {
  return Math.min(measuredH, Math.ceil(fontSize * lineHeight * maxLines))
}

export function measuredReferenceHeight(editor: Editor, reference: Reference, width: number): number {
  const leftMedia = hasLeftMedia(reference)
  const textWidth = Math.max(60, width - REF_PAD - (leftMedia ? REF_MEDIA + REF_MEDIA_GAP : 0))

  const title = editor.textMeasure.measureText(refTitle(reference) || ' ', {
    fontFamily: FONT_FAMILY, fontSize: 15, lineHeight: 1.3, fontWeight: '600', fontStyle: 'normal',
    maxWidth: textWidth, padding: '0px',
  })
  let h = REF_EYEBROW + REF_GAP + clampLines(title.h, 15, 1.3, 2)

  if (refMeta(reference)) h += REF_GAP + 17

  const desc = refDescription(reference)
  if (desc) {
    const d = editor.textMeasure.measureText(desc, {
      fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: 1.4, fontWeight: '400', fontStyle: 'normal',
      maxWidth: textWidth, padding: '0px',
    })
    h += REF_GAP + clampLines(d.h, 13, 1.4, 2)
  }

  h += REF_PAD_Y
  if (leftMedia) h = Math.max(h, REF_PAD_Y + REF_MEDIA)
  return Math.ceil(h)
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

// --- Question cards ------------------------------------------------------
// question.css: font 14px / line-height 1.4; padding 12px; a header row (the "?"
// glyph + agent mark, ~18px + 6px gap) sits above the text. Width is fixed (a
// small sticky note), so only height follows the text.
const QUESTION_PAD_X = 24 // 12 left + 12 right
const QUESTION_PAD_Y = 24 // 12 top + 12 bottom
const QUESTION_HEADER_ROW = 24 // "?" + agent mark row + its gap

export function measuredQuestionHeight(editor: Editor, text: string, width: number): number {
  const { h } = editor.textMeasure.measureText(text || ' ', {
    fontFamily: FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.4,
    fontWeight: '400',
    fontStyle: 'normal',
    maxWidth: Math.max(40, width - QUESTION_PAD_X),
    padding: '0px',
  })
  return Math.ceil(h + QUESTION_PAD_Y + QUESTION_HEADER_ROW)
}
