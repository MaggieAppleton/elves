import type { Editor } from 'tldraw'
import type { Reference } from '../model/types'
import { refMeta, refDescription, refTitle, hasLeftMedia } from '../model/references'
import { SECTION_PLACEHOLDER } from '../model/sections'

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
const CARD_BADGE_ROW = 20 // NOTE/PROSE badge line + gap (labelled cards)

export function measuredCardHeight(
  editor: Editor,
  text: string,
  width: number,
  hasBadge: boolean,
  minTextH = 0,
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
  // A prose card reserves a comfortable minimum writing area (minTextH) so a
  // blank or short draft card reads as a place to write, not a thin sliver.
  return Math.ceil(Math.max(h, minTextH) + CARD_PAD_Y + (hasBadge ? CARD_BADGE_ROW : 0))
}

// The blank writing area a prose card holds even when empty — roughly three
// lines, so a fresh draft card lands taller than a note and invites typing.
export const PROSE_TEXT_MIN = 66

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
// The user's own annotation sits BELOW the bibliographic face as a sibling —
// separated from it by the card's 6px flex gap and carrying its own 13px bottom
// padding (top padding 0). It spans the full card width (13px left/right) and,
// unlike the 2-line-clamped description, grows to fit however much the user
// writes (13px / line-height 1.4), which is why it must be measured here.
const REF_CARD_GAP = 6
const REF_ANNOTATION_PAD_B = 13

function clampLines(measuredH: number, fontSize: number, lineHeight: number, maxLines: number): number {
  return Math.min(measuredH, Math.ceil(fontSize * lineHeight * maxLines))
}

export function measuredReferenceHeight(
  editor: Editor,
  reference: Reference,
  annotation: string,
  width: number,
): number {
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

  // Grow the card to hold the annotation the user is writing/reading (both the
  // editing textarea and the read-only div occupy this same measured space).
  // Empty annotation renders nothing, so it adds no height. Measured full-width
  // (the annotation isn't offset by the left media) and unclamped.
  if (annotation) {
    const a = editor.textMeasure.measureText(annotation, {
      fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: 1.4, fontWeight: '400', fontStyle: 'normal',
      maxWidth: Math.max(60, width - REF_PAD), padding: '0px',
    })
    h += REF_CARD_GAP + Math.ceil(a.h) + REF_ANNOTATION_PAD_B
  }
  return Math.ceil(h)
}

// --- Figure cards --------------------------------------------------------
// card.css .elves-card--figure: a dashed sketch-frame with padding 14px/16px, an
// eyebrow row (image glyph + optional agent mark), a prominent title (15px/600,
// 1.3, clamped to 2 lines) over a smaller description (13.5px, 1.45) that grows
// to fit. The status chip sits absolutely in a corner, so it adds no height.
const FIG_PAD_X = 32 // 16 left + 16 right
const FIG_PAD_Y = 28 // 14 top + 14 bottom
const FIG_EYEBROW = 20 // image-glyph row + its gap
const FIG_GAP = 6
// The description area never measures shorter than the editing textarea's
// min-height (.elves-figure__desc-input min-height: 3.2em @ 13.5px ≈ 44px).
// Without this floor a blank figure's box is measured to one line, the taller
// textarea overflows it, and the clipped content pushes the eyebrow off the
// top edge. Reserving it also lets an empty frame read as "a visual goes here".
const FIG_DESC_MIN = 44

export function measuredFigureHeight(
  editor: Editor,
  title: string,
  description: string,
  width: number,
): number {
  const textWidth = Math.max(60, width - FIG_PAD_X)
  const t = editor.textMeasure.measureText(title || ' ', {
    fontFamily: FONT_FAMILY, fontSize: 15, lineHeight: 1.3, fontWeight: '600', fontStyle: 'normal',
    maxWidth: textWidth, padding: '0px',
  })
  let h = FIG_EYEBROW + FIG_GAP + clampLines(t.h, 15, 1.3, 2)
  // A figure needs a description to plan the visual; reserve room even when empty
  // so the frame reads as "a visual goes here" rather than collapsing to a line.
  const d = editor.textMeasure.measureText(description || ' ', {
    fontFamily: FONT_FAMILY, fontSize: 13.5, lineHeight: 1.45, fontWeight: '400', fontStyle: 'normal',
    maxWidth: textWidth, padding: '0px',
  })
  h += FIG_GAP + Math.max(d.h, FIG_DESC_MIN)
  return Math.ceil(h + FIG_PAD_Y)
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
  // A blank header is sized to its placeholder prompt, so "Section name" shows
  // in full while typing the first character rather than clipping to a sliver.
  const measured = text || SECTION_PLACEHOLDER
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
    const single = editor.textMeasure.measureText(measured, { ...base, maxWidth: null })
    width =
      single.w > SECTION_ONE_LINE_MAX
        ? Math.ceil(single.w / 2) + 40 // aim for ~two lines
        : Math.ceil(single.w) + 8
  }
  const { h } = editor.textMeasure.measureText(measured, { ...base, maxWidth: width })
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
