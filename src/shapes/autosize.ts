import type { Editor } from 'tldraw'
import type { CardProps, Reference } from '../model/types'
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
// card.css: font 15px / line-height 1.45; padding 12px (top/bottom) 14px (l/r);
// 1px border. The card is box-sizing:border-box, so the border eats into the
// declared w/h — the text column is (w − border − padding) wide, not (w − padding).
// Getting this 2px too generous lets a line "fit" the measurement that actually
// wraps on screen, adding a whole extra line and clipping the card. So every inset
// below counts the 1px border on each side alongside the padding.
// A note card also carries a "NOTE" badge row (badge + 6px flex gap) above
// the text; prose cards don't.
const CARD_PAD_X = 30 // 1 border + 14 pad, each side
const CARD_PAD_Y = 26 // 1 border + 12 pad, top and bottom
// NOTE/PROSE badge line + its 6px flex gap. Sized for the tallest state: when the
// card is selected the row also holds the convert-to-prose icon button (~19px, less
// the row's -4px margin, + 6px gap ≈ 21), and autosize doesn't re-measure on
// selection — so the reserve must already cover it or the last line clips on select.
const CARD_BADGE_ROW = 22

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

// --- Gist fit ------------------------------------------------------------
// Zoomed out, the gist renders at a font counter-scaled UP against the zoom
// (up to GIST_FONT_MAX, in summaryView.ts), but the card's box was measured to
// hold the FULL text at 15px. When the enlarged gist wraps taller than that box
// it used to spill out and overlap the card below. Instead we treat the zoom's
// size as a ceiling and shrink it until the whole summary fits the box, so the
// gist is always fully visible and never overflows. The gist is a summary —
// shorter than the full text the box already holds — so the fitted size almost
// always lands between 15px and the cap; the floor is only reached by a
// pathological summary longer than the card's own text, which then clips
// (the card's overflow:hidden) rather than shrinking to nothing.
const GIST_LINE_HEIGHT = 1.25 // matches card.css .elves-card__text--gist
const GIST_FONT_MIN = 13 // stay readable; below this we clip instead of shrinking

// Memoize by the inputs that determine the fit — a zoom gesture re-renders every
// gist card many times, but (gist, w, h, cap) rarely changes between frames
// (the cap is pinned at GIST_FONT_MAX across most of the gist zoom range), so
// this turns ~4 DOM measures per card per frame into one lookup.
const gistFitCache = new Map<string, number>()

/**
 * The core gist-fit search: given the text column width and vertical budget
 * ALREADY computed by the caller (each shape reserves its own chrome — cards a
 * badge row, questions a header row), shrink the zoom's font from maxFontSize
 * until the wrapped gist fits `availH`, flooring at GIST_FONT_MIN (below which
 * the shape clips instead). Pure function of its inputs, so it's memoized by
 * them — a zoom gesture re-renders every gist many times but the insets rarely
 * change between frames.
 */
function fitGistFontSize(
  editor: Editor,
  gist: string,
  maxWidth: number,
  availH: number,
  maxFontSize: number,
): number {
  const key = `${gist}|${maxWidth}|${availH}|${maxFontSize}`
  const cached = gistFitCache.get(key)
  if (cached !== undefined) return cached

  const fits = (fontSize: number) =>
    editor.textMeasure.measureText(gist || ' ', {
      fontFamily: FONT_FAMILY,
      fontSize,
      lineHeight: GIST_LINE_HEIGHT,
      fontWeight: '500',
      fontStyle: 'normal',
      maxWidth,
      padding: '0px',
    }).h <= availH

  let result = maxFontSize
  if (!fits(maxFontSize)) {
    // Largest integer size in [GIST_FONT_MIN, maxFontSize] whose wrapped height
    // fits; if even the floor overflows, the shape's overflow:hidden clips it.
    let lo = GIST_FONT_MIN
    let hi = maxFontSize
    let best = GIST_FONT_MIN
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(mid)) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    result = best
  }

  // Cap the cache so a long session of edits can't grow it unbounded; the working
  // set (visible gist shapes at the current zoom) is small, so a simple clear is fine.
  if (gistFitCache.size > 500) gistFitCache.clear()
  gistFitCache.set(key, result)
  return result
}

export function fittedGistFontSize(
  editor: Editor,
  gist: string,
  width: number,
  height: number,
  maxFontSize: number,
): number {
  // A card reserves CARD_PAD_X/Y of chrome; its overflow:hidden clips the rest.
  return fitGistFontSize(
    editor,
    gist,
    Math.max(40, width - CARD_PAD_X),
    height - CARD_PAD_Y,
    maxFontSize,
  )
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
// The title (unlike the description) carries a right pad clearing the absolutely
// positioned status chip (.elves-figure__title padding-right: 66px). Measure it in
// that narrower column, or a title that wraps to two lines on screen measures as
// one — under-reserving a line and stealing the card's bottom padding.
const FIG_TITLE_PAD_R = 66
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
    maxWidth: Math.max(60, width - FIG_PAD_X - FIG_TITLE_PAD_R), padding: '0px',
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

/**
 * Selects the height policy for any card face. `width` lets resize callers
 * measure at the pending width before it has been committed to the shape.
 * Image cards are user-sized rather than text-sized, so their current height
 * passes through unchanged.
 */
export function measuredCardPropsHeight(
  editor: Editor,
  props: CardProps,
  width = props.w,
): number {
  if (props.noteKind === 'image') return props.h
  if (props.kind === 'figure') {
    return measuredFigureHeight(editor, props.figureTitle, props.text, width)
  }
  if (props.noteKind === 'reference' && props.reference) {
    return measuredReferenceHeight(editor, props.reference, props.text, width)
  }
  return measuredCardHeight(
    editor,
    props.text,
    width,
    props.kind === 'note' || props.kind === 'prose',
    props.kind === 'prose' ? PROSE_TEXT_MIN : 0,
  )
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
// question.css: font 14px / line-height 1.4; padding 12px; 1px border. Like the
// cards above it is box-sizing:border-box, so the border eats into the declared
// w/h — count it in both insets or the text column measures too wide and wraps to
// an extra clipped line. A fixed-height header row (the "?" glyph + agent mark,
// 18px + 6px gap) sits above the text; only height follows the text.
const QUESTION_PAD_X = 26 // 1 border + 12 pad, each side
const QUESTION_PAD_Y = 26 // 1 border + 12 pad, top and bottom
const QUESTION_HEADER_ROW = 24 // 18px header + 6px gap

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

/**
 * Fit a question's gist to its box. Unlike a card, a question ALWAYS shows its
 * header row (the "?" glyph + agent mark), so the gist's vertical budget is the
 * box height minus the padding AND that header row — the same reservation
 * measuredQuestionHeight makes. Reusing the card fit (which only subtracts
 * CARD_PAD_Y) left the gist 24px too much room, so a short question's enlarged
 * gist could render at the cap and spill out of the box (questions have no
 * overflow:hidden). This delegates to the shared fit with the RIGHT insets.
 */
export function fittedQuestionGistFontSize(
  editor: Editor,
  gist: string,
  width: number,
  height: number,
  maxFontSize: number,
): number {
  return fitGistFontSize(
    editor,
    gist,
    Math.max(40, width - QUESTION_PAD_X),
    height - QUESTION_PAD_Y - QUESTION_HEADER_ROW,
    maxFontSize,
  )
}
