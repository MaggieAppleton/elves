import { describe, it, expect } from 'vitest'
import type { Editor } from 'tldraw'
import type { Reference } from '../../src/model/types'
import {
  measuredCardHeight, measuredReferenceHeight, measuredSectionSize, fittedGistFontSize,
  measuredQuestionHeight, fittedQuestionGistFontSize,
} from '../../src/shapes/autosize'

function ref(overrides: Partial<Reference> = {}): Reference {
  return {
    url: 'https://example.com', refType: 'link', title: 'A source', authors: [], siteName: null,
    year: null, venue: null, description: null, faviconAssetId: null, thumbnailAssetId: null,
    doi: null, arxivId: null, fetchedBy: null, fetchedAt: null, ...overrides,
  }
}

/**
 * The auto-size helpers only ever call `editor.textMeasure.measureText`, so we
 * stub that with a predictable layout: text height = number of wrapped lines *
 * fontSize * lineHeight, where a "line" holds maxWidth/10 characters. That lets
 * us assert the chrome math (padding + badge) and the section two-line wrap
 * without a real browser/DOM.
 */
function fakeEditor(): { editor: Editor; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const measureText = (text: string, opts: Record<string, unknown>) => {
    calls.push({ text, ...opts })
    const maxWidth = opts.maxWidth as number | null
    const perLine = maxWidth == null ? Infinity : Math.max(1, Math.floor(maxWidth / 10))
    const lines = Math.max(1, Math.ceil(text.length / perLine))
    const singleLineW = text.length * 10
    const w = maxWidth == null ? singleLineW : Math.min(singleLineW, maxWidth)
    const h = lines * (opts.fontSize as number) * (opts.lineHeight as number)
    return { x: 0, y: 0, w, h, scrollWidth: w }
  }
  return { editor: { textMeasure: { measureText } } as unknown as Editor, calls }
}

describe('measuredCardHeight', () => {
  it('measures at the content width (card width minus 30px = 1px border + 14px padding each side)', () => {
    const { editor, calls } = fakeEditor()
    measuredCardHeight(editor, 'hello', 250, true)
    expect(calls[0].maxWidth).toBe(250 - 30)
    expect(calls[0].fontSize).toBe(15)
  })

  it('adds badge chrome for note cards but not prose cards', () => {
    const { editor } = fakeEditor()
    // 'hello' (5 chars) fits one line at width 250 => textH = 15 * 1.45 = 21.75
    const source = measuredCardHeight(editor, 'hello', 250, true)
    const prose = measuredCardHeight(editor, 'hello', 250, false)
    expect(source - prose).toBe(22) // the NOTE/PROSE badge row + gap
    expect(prose).toBe(Math.ceil(21.75 + 26)) // text + vertical padding + border only
  })

  it('grows with more text (more wrapped lines => taller)', () => {
    const { editor } = fakeEditor()
    const short = measuredCardHeight(editor, 'a'.repeat(20), 250, true)
    const long = measuredCardHeight(editor, 'a'.repeat(400), 250, true)
    expect(long).toBeGreaterThan(short)
  })

  it('never measures with a maxWidth below the 40px floor', () => {
    const { editor, calls } = fakeEditor()
    measuredCardHeight(editor, 'x', 10, false)
    expect(calls[0].maxWidth).toBe(40)
  })
})

describe('measuredReferenceHeight', () => {
  it('grows to fit a non-empty annotation (taller than an empty annotation)', () => {
    const { editor } = fakeEditor()
    const r = ref()
    const bare = measuredReferenceHeight(editor, r, '', 250)
    const annotated = measuredReferenceHeight(editor, r, 'a'.repeat(200), 250)
    expect(annotated).toBeGreaterThan(bare)
  })

  it('grows with more annotation text (more wrapped lines => taller)', () => {
    const { editor } = fakeEditor()
    const r = ref()
    const short = measuredReferenceHeight(editor, r, 'a'.repeat(20), 250)
    const long = measuredReferenceHeight(editor, r, 'a'.repeat(400), 250)
    expect(long).toBeGreaterThan(short)
  })

  it('measures the annotation at full card width (13px left/right padding)', () => {
    const { editor, calls } = fakeEditor()
    measuredReferenceHeight(editor, ref(), 'note', 250)
    const annotationCall = calls.find((c) => c.text === 'note')
    expect(annotationCall).toBeDefined()
    expect(annotationCall!.maxWidth).toBe(250 - 26)
  })
})

describe('fittedGistFontSize', () => {
  // fake model: perLine = floor((w-30)/10) chars; h = lines * fontSize * 1.25.
  // availH = height - 26 (CARD_PAD_Y).
  it('uses the full ceiling size when the gist already fits the box', () => {
    const { editor } = fakeEditor()
    // 'hello' => 1 line; at 25px => h = 31.25; box height 100 => availH 74 >> 31.25.
    expect(fittedGistFontSize(editor, 'hello', 250, 100, 25)).toBe(25)
  })

  it('shrinks below the ceiling until the whole gist fits', () => {
    const { editor } = fakeEditor()
    // 66 chars at width 250 (perLine 22) => 3 lines; h(f) = 3.75f.
    // box height 86 => availH 60 => largest integer f with 3.75f <= 60 is 16.
    const size = fittedGistFontSize(editor, 'a'.repeat(66), 250, 86, 25)
    expect(size).toBe(16)
    expect(size).toBeLessThan(25)
  })

  it('never shrinks below the 13px readability floor (clips instead)', () => {
    const { editor } = fakeEditor()
    // 220 chars => 10 lines; even at 13px h = 162.5 >> availH 14, so it can't fit.
    expect(fittedGistFontSize(editor, 'a'.repeat(220), 250, 40, 25)).toBe(13)
  })

  it('memoizes by (gist, w, h, ceiling) so repeated renders re-measure nothing', () => {
    const { editor, calls } = fakeEditor()
    const uniq = 'memo-probe-' + 'z'.repeat(50)
    fittedGistFontSize(editor, uniq, 240, 80, 25)
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    fittedGistFontSize(editor, uniq, 240, 80, 25)
    expect(calls.length).toBe(afterFirst) // cache hit: no new measureText calls
  })
})

describe('fittedQuestionGistFontSize', () => {
  // A question ALWAYS shows its header row, so the gist's true vertical budget
  // is height - QUESTION_PAD_Y(26) - QUESTION_HEADER_ROW(24) = height - 50,
  // whereas the card fit only reserves CARD_PAD_Y(26). These prove the question
  // fit reserves that extra header row, so a short question's gist can't spill.
  const GIST = 'The smell of the room' // 21 chars => 1 line at these widths

  it('reserves the header row: a short one-line question box fits its gist below the cap', () => {
    const { editor } = fakeEditor()
    // A one-line question at w=370: measuredQuestionHeight = ceil(19.6 + 26 + 24) = 70.
    const h = measuredQuestionHeight(editor, 'q?', 370)
    expect(h).toBe(70)
    // availH = 70 - 50 = 20; the gist is 1 line so h(f) = 1.25f; at the 25px cap
    // that's 31.25 > 20 and must shrink to the largest f with 1.25f <= 20 => 16.
    const size = fittedQuestionGistFontSize(editor, GIST, 370, h, 25)
    expect(size).toBe(16)
    expect(size).toBeLessThan(25) // a known-overflowing case shrinks below the cap
    // And the fitted size's wrapped height fits the TRUE text budget (not the
    // over-generous card budget), i.e. it stays inside the box above the header.
    const wrapped = editor.textMeasure.measureText(GIST, {
      fontFamily: "'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif",
      fontSize: size, lineHeight: 1.25, fontWeight: '500', fontStyle: 'normal',
      maxWidth: Math.max(40, 370 - 26), padding: '0px',
    }).h
    expect(wrapped).toBeLessThanOrEqual(70 - 26 - 24)
  })

  it('reserves strictly more chrome than the card fit for the same box', () => {
    const { editor } = fakeEditor()
    const h = measuredQuestionHeight(editor, 'q?', 370) // 70
    // Card fit sees availH = 70 - 26 = 44 (fits the 1-line gist at 25px cap);
    // question fit sees availH = 20 and must shrink — so it's never larger.
    const asCard = fittedGistFontSize(editor, GIST, 370, h, 25)
    const asQuestion = fittedQuestionGistFontSize(editor, GIST, 370, h, 25)
    expect(asCard).toBe(25)
    expect(asQuestion).toBeLessThanOrEqual(asCard)
    expect(asQuestion).toBeLessThan(asCard)
  })
})

describe('measuredSectionSize', () => {
  it('keeps the current width when not fitting, only setting height', () => {
    const { editor } = fakeEditor()
    const { w, h } = measuredSectionSize(editor, 'Short', 600, false)
    expect(w).toBe(600)
    expect(h).toBeGreaterThan(0)
  })

  it('fits a short label to a single line plus a little slack', () => {
    const { editor } = fakeEditor()
    // 'Refs' => single-line width 40 (<= 520) => w = 40 + 8
    const { w } = measuredSectionSize(editor, 'Refs', 320, true)
    expect(w).toBe(48)
  })

  it('wraps a long label toward two lines instead of one very wide line', () => {
    const { editor } = fakeEditor()
    const label = 'Evidence: extensible software that works' // 40 chars => single-line 400...
    // make it exceed the 520 one-line threshold:
    const long = 'x'.repeat(60) // single-line width 600 > 520
    const { w } = measuredSectionSize(editor, long, 320, true)
    expect(w).toBe(Math.ceil(600 / 2) + 40) // ~two lines
    expect(w).toBeLessThan(600) // narrower than the one-line width
    void label
  })
})
