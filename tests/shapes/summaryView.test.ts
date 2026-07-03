import { expect, test } from 'vitest'
import { shouldShowGist, GIST_ZOOM } from '../../src/shapes/summaryView'

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
