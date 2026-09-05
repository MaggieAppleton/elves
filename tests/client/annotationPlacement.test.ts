import { expect, test } from 'vitest'
import {
  annotationThreadMaxHeight,
  arrangeAnnotationThreads,
  placeAnnotationThread,
} from '../../src/client/annotationPlacement'

const viewport = { left: 0, top: 0, width: 800, height: 600 }
const thread = { width: 300, height: 180 }

test('prefers the first source-excluding position in stable right-left-above-below order', () => {
  expect(placeAnnotationThread(
    { left: 500, top: 220, width: 28, height: 28 },
    thread,
    viewport,
    { source: { left: 300, top: 120, width: 120, height: 260 } },
  )).toEqual({ left: 432, top: 220, side: 'right' })
})

test('falls back at a viewport edge without covering the host source', () => {
  const source = { left: 620, top: 120, width: 160, height: 260 }
  const placement = placeAnnotationThread(
    { left: 740, top: 220, width: 28, height: 28 },
    thread,
    viewport,
    { source },
  )
  expect(placement.left).toBeGreaterThanOrEqual(8)
  expect(placement.left + thread.width).toBeLessThanOrEqual(792)
  expect(placement.top).toBeGreaterThanOrEqual(source.top + source.height + 12)
})

test('scores existing panels before pin distance', () => {
  const anchor = { left: 380, top: 220, width: 28, height: 28 }
  const source = { left: 340, top: 140, width: 100, height: 340 }
  const placement = placeAnnotationThread(anchor, thread, viewport, {
    source,
    obstacles: [{ left: 452, top: 220, width: 300, height: 180 }],
  })
  expect(placement.side).toBe('left')
  expect(placement.left + thread.width).toBeLessThanOrEqual(source.left - 12)
})

test('keeps a valid preferred side stable as panel height changes', () => {
  const anchor = { left: 340, top: 100, width: 28, height: 28 }
  const source = { left: 300, top: 70, width: 100, height: 160 }
  const first = placeAnnotationThread(anchor, thread, viewport, { source })
  const streamed = placeAnnotationThread(anchor, { ...thread, height: 260 }, viewport, {
    source,
    preferredSide: first.side,
  })
  expect(streamed.side).toBe(first.side)
})

test('keeps a clamped edge placement on the same side as streamed content grows', () => {
  const anchor = { left: 340, top: 540, width: 28, height: 28 }
  const source = { left: 300, top: 500, width: 100, height: 80 }
  const first = placeAnnotationThread(anchor, { width: 300, height: 60 }, viewport, {
    source,
    preferredSide: 'right',
  })
  const streamed = placeAnnotationThread(anchor, { width: 300, height: 180 }, viewport, {
    source,
    preferredSide: first.side,
  })
  expect(first.side).toBe('right')
  expect(streamed.side).toBe('right')
  expect(streamed.top + 180).toBeLessThanOrEqual(viewport.height - 8)
})

test('arranges two colliding panels with a visible selectable edge', () => {
  const geometry = {
    anchor: { left: 300, top: 160, width: 28, height: 28 },
    source: { left: 260, top: 100, width: 100, height: 200 },
    thread,
  }
  const placements = arrangeAnnotationThreads([
    { key: 'active', ...geometry },
    { key: 'prior', ...geometry },
  ], viewport)
  expect(placements.active.side).toBe('right')
  expect(Math.abs(placements.active.top - placements.prior.top)).toBeGreaterThanOrEqual(32)
})

test('keeps visible inactive pins clear of an open thread', () => {
  const geometry = {
    key: 'active',
    anchor: { left: 500, top: 220, width: 28, height: 28 },
    source: { left: 300, top: 120, width: 120, height: 260 },
    thread,
  }
  const unprotected = arrangeAnnotationThreads([geometry], viewport).active
  const pin = { left: unprotected.left + 12, top: unprotected.top + 12, width: 28, height: 28 }
  const protectedPlacement = arrangeAnnotationThreads([geometry], viewport, { pinObstacles: [pin] }).active

  expect(protectedPlacement).not.toEqual(unprotected)
  expect(
    protectedPlacement.left + thread.width <= pin.left ||
    protectedPlacement.left >= pin.left + pin.width ||
    protectedPlacement.top + thread.height <= pin.top ||
    protectedPlacement.top >= pin.top + pin.height,
  ).toBe(true)
})

test('keeps a safe preview placement when the same target expands in place', () => {
  const geometry = {
    key: 'preview',
    anchor: { left: 600, top: 180, width: 28, height: 28 },
    source: { left: 500, top: 8, width: 200, height: 584 },
  }
  const preview = arrangeAnnotationThreads([{ ...geometry, thread: { width: 300, height: 80 } }], viewport).preview
  const expanded = arrangeAnnotationThreads([{
    ...geometry,
    thread: { width: 300, height: 180 },
    preservePlacement: preview,
  }], viewport).preview

  expect(expanded).toEqual(preview)
})

test('relocates a preview position that would cover its source after expansion', () => {
  const geometry = {
    key: 'preview',
    anchor: { left: 340, top: 180, width: 28, height: 28 },
    source: { left: 300, top: 120, width: 100, height: 220 },
  }
  const preview = arrangeAnnotationThreads([{ ...geometry, thread: { width: 180, height: 80 } }], viewport).preview
  const expanded = arrangeAnnotationThreads([{
    ...geometry,
    thread: { width: 240, height: 140 },
    preservePlacement: preview,
  }], viewport).preview

  expect(preview).toEqual({ left: 264, top: 28, side: 'above' })
  expect(expanded).toEqual({ left: 412, top: 180, side: 'right' })
})

test('clamps an edge anchor and an over-sized panel into the viewport', () => {
  expect(placeAnnotationThread({ left: 760, top: 560, width: 28, height: 28 }, { width: 900, height: 700 }, viewport))
    .toMatchObject({ left: 0, top: 0 })
})

test('caps foreground threads to the stage height while retaining the placement gutter', () => {
  expect(annotationThreadMaxHeight(420)).toBe(404)
  expect(annotationThreadMaxHeight(12)).toBe(0)
})
