import { expect, test } from 'vitest'
import {
  shouldShowGist, gistFontSize, GIST_ZOOM, GIST_FONT_MIN, GIST_FONT_MAX,
} from '../../src/shapes/summaryView'

const summarized = { sourceKind: null, summary: 'a gist' } as const
const OUT = GIST_ZOOM - 0.1
const IN = GIST_ZOOM + 0.1

test('zoomed in: never show the gist', () => {
  expect(shouldShowGist(IN, summarized)).toBe(false)
  expect(shouldShowGist(1, summarized)).toBe(false)
})

test('zoomed out with a summary: show the gist', () => {
  expect(shouldShowGist(OUT, summarized)).toBe(true)
})

test('zoomed out but no summary (short or ungenerated): keep the real text', () => {
  expect(shouldShowGist(OUT, { sourceKind: null, summary: null })).toBe(false)
})

test('image and reference cards never swap to a gist', () => {
  expect(shouldShowGist(OUT, { sourceKind: 'image', summary: 'x' })).toBe(false)
  expect(shouldShowGist(OUT, { sourceKind: 'reference', summary: 'x' })).toBe(false)
})

test('gistFontSize is a consistent, clamped size across the zoom-out range', () => {
  // Pure function of zoom → every card gets the SAME size at a given zoom, so
  // the summaries read as one consistent set rather than per-card sizes.
  for (const z of [0.1, 0.2, 0.3, 0.45, 0.49]) {
    expect(gistFontSize(z)).toBeGreaterThanOrEqual(GIST_FONT_MIN)
    expect(gistFontSize(z)).toBeLessThanOrEqual(GIST_FONT_MAX)
    // Always larger than the normal 15px card text, so it reads clearly.
    expect(gistFontSize(z)).toBeGreaterThan(15)
  }
})
