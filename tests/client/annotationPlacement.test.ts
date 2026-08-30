import { expect, test } from 'vitest'
import { annotationThreadMaxHeight, placeAnnotationThread } from '../../src/client/annotationPlacement'

const viewport = { left: 0, top: 0, width: 800, height: 600 }
const thread = { width: 300, height: 180 }

test('prefers the space beside the pin', () => {
  expect(placeAnnotationThread({ left: 500, top: 220, width: 28, height: 28 }, thread, viewport))
    .toEqual({ left: 188, top: 220, side: 'left' })
})

test('flips when the preferred side has insufficient room', () => {
  expect(placeAnnotationThread({ left: 30, top: 220, width: 28, height: 28 }, thread, viewport).side)
    .toBe('right')
})

test('clamps an edge anchor and an over-sized panel into the viewport', () => {
  expect(placeAnnotationThread({ left: 760, top: 560, width: 28, height: 28 }, { width: 900, height: 700 }, viewport))
    .toMatchObject({ left: 0, top: 0 })
})

test('caps foreground threads to the stage height while retaining the placement gutter', () => {
  expect(annotationThreadMaxHeight(420)).toBe(404)
  expect(annotationThreadMaxHeight(12)).toBe(0)
})
