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

test('gistFontSize counter-scales with zoom and stays within its clamp', () => {
  // Deeper zoom-out → larger card-space font (to hold on-screen size).
  expect(gistFontSize(0.4)).toBeGreaterThan(gistFontSize(0.49))
  // Clamped both ends: never smaller than the floor, never larger than the cap.
  expect(gistFontSize(0.49)).toBeGreaterThanOrEqual(GIST_FONT_MIN)
  expect(gistFontSize(0.01)).toBeLessThanOrEqual(GIST_FONT_MAX)
  expect(gistFontSize(0.2)).toBeLessThanOrEqual(GIST_FONT_MAX)
  // Always bigger than the normal 15px card text, so it reads as "larger".
  expect(gistFontSize(0.49)).toBeGreaterThan(15)
})
