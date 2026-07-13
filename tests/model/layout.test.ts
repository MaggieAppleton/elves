import { describe, expect, test } from 'vitest'
import {
  cascadeOffset,
  CASCADE_STEP,
  CASCADE_WRAP,
  placeBelowObstacles,
  reflowVerticalLane,
} from '../../src/model/layout'

describe('cascadeOffset', () => {
  test('first spawn has no offset', () => {
    expect(cascadeOffset(0)).toEqual({ dx: 0, dy: 0 })
  })

  test('consecutive spawns get distinct offsets', () => {
    const a = cascadeOffset(0)
    const b = cascadeOffset(1)
    expect(a).not.toEqual(b)
    expect(b).toEqual({ dx: CASCADE_STEP, dy: CASCADE_STEP })
  })

  test('wraps back to zero after CASCADE_WRAP steps so cards do not drift off-screen', () => {
    expect(cascadeOffset(CASCADE_WRAP)).toEqual({ dx: 0, dy: 0 })
    expect(cascadeOffset(CASCADE_WRAP + 1)).toEqual(cascadeOffset(1))
  })
})

describe('placeBelowObstacles', () => {
  test('places a colliding rectangle exactly 24px below the obstacle', () => {
    expect(placeBelowObstacles(
      { x: 0, y: 20, w: 100, h: 50 },
      [{ x: 0, y: 0, w: 100, h: 50 }],
    )).toEqual({ x: 0, y: 74, w: 100, h: 50 })
  })

  test('walks past a stack of obstacles', () => {
    expect(placeBelowObstacles(
      { x: 0, y: 0, w: 100, h: 50 },
      [
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 0, y: 74, w: 100, h: 50 },
      ],
    )).toEqual({ x: 0, y: 148, w: 100, h: 50 })
  })

  test('leaves an exact 24px horizontal gap untouched', () => {
    expect(placeBelowObstacles(
      { x: 124, y: 0, w: 100, h: 50 },
      [{ x: 0, y: 0, w: 100, h: 50 }],
    )).toEqual({ x: 124, y: 0, w: 100, h: 50 })
  })
})

describe('reflowVerticalLane', () => {
  test('pushes only downstream items in the same horizontal lane', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 140 } },
      { id: 'b', rect: { x: 0, y: 100, w: 100, h: 50 } },
      { id: 'side', rect: { x: 200, y: 100, w: 100, h: 50 } },
    ])).toEqual([{ id: 'b', x: 0, y: 164 }])
  })

  test('pushes a contiguous stack without collapsing intentional whitespace', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 140 } },
      { id: 'b', rect: { x: 0, y: 100, w: 100, h: 50 } },
      { id: 'c', rect: { x: 0, y: 170, w: 100, h: 50 } },
      { id: 'far', rect: { x: 0, y: 400, w: 100, h: 50 } },
    ])).toEqual([
      { id: 'b', x: 0, y: 164 },
      { id: 'c', x: 0, y: 238 },
    ])
  })

  test('compacts a previously contiguous stack when the anchor shrinks', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 60 } },
      { id: 'b', rect: { x: 0, y: 164, w: 100, h: 50 } },
      { id: 'c', rect: { x: 0, y: 238, w: 100, h: 50 } },
    ], 140)).toEqual([
      { id: 'b', x: 0, y: 84 },
      { id: 'c', x: 0, y: 158 },
    ])
  })

  test('does not compact across intentional whitespace', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 60 } },
      { id: 'far', rect: { x: 0, y: 200, w: 100, h: 50 } },
    ], 140)).toEqual([])
  })
})
