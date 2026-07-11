import { expect, test } from 'vitest'
import {
  shouldShowGist, shouldShowQuestionGist, gistFontSize, gistTagFontSize,
  GIST_ZOOM, GIST_FONT_MAX, GIST_TAG_RATIO,
} from '../../src/shapes/summaryView'

const summarized = { noteKind: null, summary: 'a gist' } as const
const OUT = GIST_ZOOM - 0.1
const IN = GIST_ZOOM + 0.1

test('zoomed in: never show the gist', () => {
  expect(shouldShowGist(IN, summarized)).toBe(false)
  expect(shouldShowGist(1, summarized)).toBe(false)
})

test('zoomed out with a summary: show the gist', () => {
  expect(shouldShowGist(OUT, summarized)).toBe(true)
})

test('zoomed out, no summary, no text: keep the real text', () => {
  expect(shouldShowGist(OUT, { noteKind: null, summary: null })).toBe(false)
  expect(shouldShowGist(OUT, { noteKind: null, summary: null, text: '' })).toBe(false)
})

test('zoomed out, no summary but non-empty text: show the mechanical gist', () => {
  expect(shouldShowGist(OUT, { noteKind: null, summary: null, text: 'some real text' })).toBe(true)
})

test('image and reference cards never swap to a gist', () => {
  expect(shouldShowGist(OUT, { noteKind: 'image', summary: 'x' })).toBe(false)
  expect(shouldShowGist(OUT, { noteKind: 'reference', summary: 'x' })).toBe(false)
})

test('gistFontSize is a consistent, clamped size across the zoom-out range', () => {
  // Pure function of zoom → every card gets the SAME size at a given zoom, so
  // the summaries read as one consistent set rather than per-card sizes.
  // Across the whole gist zoom-out range the counter-scale always wants more
  // than the cap, so every gist lands on exactly GIST_FONT_MAX — one uniform,
  // clearly-readable size (well above the normal 15px card text).
  for (const z of [0.1, 0.2, 0.3, 0.45, 0.49]) {
    expect(gistFontSize(z)).toBe(GIST_FONT_MAX)
  }
})

test('gist tag chip is a fixed, smaller ratio of the gist size at every zoom', () => {
  // Derived from the gist size so the tag chip and gist line stay visually
  // paired — always clearly smaller, never independently drifting.
  for (const z of [0.1, 0.2, 0.3, 0.45, 0.6, 0.69]) {
    expect(gistTagFontSize(z)).toBe(Math.round(gistFontSize(z) * GIST_TAG_RATIO))
    expect(gistTagFontSize(z)).toBeLessThan(gistFontSize(z))
  }
})

test('shouldShowQuestionGist: only below GIST_ZOOM and only with content', () => {
  expect(shouldShowQuestionGist(1, { summary: 'g', text: 'q?' })).toBe(false) // zoomed in
  expect(shouldShowQuestionGist(0.5, { summary: 'g', text: 'q?' })).toBe(true) // summary
  expect(shouldShowQuestionGist(0.5, { summary: null, text: 'q?' })).toBe(true) // falls back to text
  expect(shouldShowQuestionGist(0.5, { summary: null, text: '   ' })).toBe(false) // empty
})
