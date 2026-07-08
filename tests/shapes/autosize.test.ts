import { describe, it, expect } from 'vitest'
import type { Editor } from 'tldraw'
import type { Reference } from '../../src/model/types'
import {
  measuredCardHeight, measuredReferenceHeight, measuredSectionSize,
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
  it('measures at the content width (card width minus 28px padding)', () => {
    const { editor, calls } = fakeEditor()
    measuredCardHeight(editor, 'hello', 250, true)
    expect(calls[0].maxWidth).toBe(250 - 28)
    expect(calls[0].fontSize).toBe(15)
  })

  it('adds badge chrome for note cards but not prose cards', () => {
    const { editor } = fakeEditor()
    // 'hello' (5 chars) fits one line at width 250 => textH = 15 * 1.45 = 21.75
    const source = measuredCardHeight(editor, 'hello', 250, true)
    const prose = measuredCardHeight(editor, 'hello', 250, false)
    expect(source - prose).toBe(20) // the NOTE badge row
    expect(prose).toBe(Math.ceil(21.75 + 24)) // text + vertical padding only
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
