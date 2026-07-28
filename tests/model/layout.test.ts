import { describe, expect, test } from 'vitest'
import {
  CANVAS_GAP,
  cascadeOffset,
  CASCADE_STEP,
  CASCADE_WRAP,
  placeBelowObstacles,
  reflowVerticalLane,
  findOverlaySlot,
  snapHalo,
  snapToNeighbours,
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

// Expectations are written in terms of the gap rather than its current value,
// so retuning CANVAS_GAP retunes the suite instead of breaking it.
const G = CANVAS_GAP

describe('placeBelowObstacles', () => {
  test('places a colliding rectangle exactly one gap below the obstacle', () => {
    expect(placeBelowObstacles(
      { x: 0, y: 20, w: 100, h: 50 },
      [{ x: 0, y: 0, w: 100, h: 50 }],
    )).toEqual({ x: 0, y: 50 + G, w: 100, h: 50 })
  })

  test('walks past a stack of obstacles', () => {
    expect(placeBelowObstacles(
      { x: 0, y: 0, w: 100, h: 50 },
      [
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 0, y: 50 + G, w: 100, h: 50 },
      ],
    )).toEqual({ x: 0, y: 100 + 2 * G, w: 100, h: 50 })
  })

  test('leaves an exact one-gap horizontal separation untouched', () => {
    expect(placeBelowObstacles(
      { x: 100 + G, y: 0, w: 100, h: 50 },
      [{ x: 0, y: 0, w: 100, h: 50 }],
    )).toEqual({ x: 100 + G, y: 0, w: 100, h: 50 })
  })
})

describe('reflowVerticalLane', () => {
  test('pushes only downstream items in the same horizontal lane', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 140 } },
      { id: 'b', rect: { x: 0, y: 100, w: 100, h: 50 } },
      { id: 'side', rect: { x: 200, y: 100, w: 100, h: 50 } },
    ])).toEqual([{ id: 'b', x: 0, y: 140 + G }])
  })

  test('pushes a contiguous stack without collapsing intentional whitespace', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 140 } },
      { id: 'b', rect: { x: 0, y: 100, w: 100, h: 50 } },
      { id: 'c', rect: { x: 0, y: 170, w: 100, h: 50 } },
      { id: 'far', rect: { x: 0, y: 400, w: 100, h: 50 } },
    ])).toEqual([
      { id: 'b', x: 0, y: 140 + G },
      { id: 'c', x: 0, y: 190 + 2 * G },
    ])
  })

  test('compacts a previously contiguous stack when the anchor shrinks', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 60 } },
      { id: 'b', rect: { x: 0, y: 140 + G, w: 100, h: 50 } },
      { id: 'c', rect: { x: 0, y: 190 + 2 * G, w: 100, h: 50 } },
    ], 140)).toEqual([
      { id: 'b', x: 0, y: 60 + G },
      { id: 'c', x: 0, y: 110 + 2 * G },
    ])
  })

  test('does not compact across intentional whitespace', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 60 } },
      // Beyond the anchor's old bottom plus a gap, so it reads as a deliberate
      // break in the column rather than the next card in it.
      { id: 'far', rect: { x: 0, y: 140 + 3 * G, w: 100, h: 50 } },
    ], 140)).toEqual([])
  })

  test('compacts small server measurement slack with the changed stack', () => {
    expect(reflowVerticalLane('a', [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 60 } },
      { id: 'b', rect: { x: 0, y: 146 + G, w: 100, h: 50 } },
    ], 140)).toEqual([{ id: 'b', x: 0, y: 60 + G }])
  })
})

describe('findOverlaySlot', () => {
  const anchor = { x: 100, y: 100, w: 100, h: 80 }
  const overlay = { w: 100, h: 60 }

  const rightSlot = { x: 200 + G, y: 100 }
  const leftSlot = { x: -G, y: 100 }
  const belowSlot = { x: 100, y: 180 + G }
  const aboveSlot = { x: 100, y: 40 - G }

  test('prefers the clear slot to the right', () => {
    expect(findOverlaySlot(anchor, overlay, []))
      .toEqual({ ...rightSlot, w: 100, h: 60 })
  })

  test('uses the left slot when the right slot is occupied', () => {
    expect(findOverlaySlot(anchor, overlay, [
      { ...rightSlot, w: 100, h: 80 },
    ])).toEqual({ ...leftSlot, w: 100, h: 60 })
  })

  test('uses the slot below when both sides are occupied', () => {
    expect(findOverlaySlot(anchor, overlay, [
      { ...rightSlot, w: 100, h: 80 },
      { ...leftSlot, w: 100, h: 80 },
    ])).toEqual({ ...belowSlot, w: 100, h: 60 })
  })

  test('falls down the right lane when all immediate slots are occupied', () => {
    expect(findOverlaySlot(anchor, overlay, [
      { ...rightSlot, w: 100, h: 80 },
      { ...leftSlot, w: 100, h: 80 },
      { ...belowSlot, w: 100, h: 60 },
      { ...aboveSlot, w: 100, h: 60 },
    ])).toEqual({ x: 200 + G, y: 180 + G, w: 100, h: 60 })
  })
})

describe('snapToNeighbours', () => {
  // One neighbour, and a dragged card of the same size, so every expectation
  // below reads as "one gap away, edges aligned".
  const neighbour = { x: 100, y: 100, w: 200, h: 80 }
  const dragged = (x: number, y: number) => ({ x, y, w: 200, h: 80 })
  const RADIUS = 40

  const below = { x: 100, y: 180 + G }
  const above = { x: 100, y: 20 - G }
  const right = { x: 300 + G, y: 100 }
  const left = { x: -100 - G, y: 100 }

  // The landing point, separated from the `snappedTo` reporting so the position
  // assertions stay exact.
  const point = ({ x, y }: { x: number; y: number }) => ({ x, y })

  test('snaps to a clean gap below with left edges aligned', () => {
    // Dropped 6px right and 10px low of the true slot.
    const result = snapToNeighbours(dragged(below.x + 6, below.y + 10), [neighbour], RADIUS)
    expect(point(result)).toEqual(below)
    expect(result.snappedTo).toEqual(neighbour)
  })

  test('snaps above the neighbour, left edges aligned', () => {
    expect(point(snapToNeighbours(dragged(above.x - 6, above.y + 10), [neighbour], RADIUS)))
      .toEqual(above)
  })

  test('snaps to the right with top edges aligned', () => {
    expect(point(snapToNeighbours(dragged(right.x - 14, right.y - 8), [neighbour], RADIUS)))
      .toEqual(right)
  })

  test('snaps to the left with top edges aligned', () => {
    expect(point(snapToNeighbours(dragged(left.x + 14, left.y + 8), [neighbour], RADIUS)))
      .toEqual(left)
  })

  test('leaves the card where it was dropped when every slot is out of range', () => {
    const result = snapToNeighbours(dragged(700, 700), [neighbour], RADIUS)
    expect(point(result)).toEqual({ x: 700, y: 700 })
    // Nothing to highlight when nothing was joined.
    expect(result.snappedTo).toBeNull()
  })

  test('does not snap a card sitting just outside the radius', () => {
    // One pixel past the radius, straight below the below-slot.
    const y = below.y + RADIUS + 1
    const result = snapToNeighbours(dragged(below.x, y), [neighbour], RADIUS)
    expect(point(result)).toEqual({ x: below.x, y })
    expect(result.snappedTo).toBeNull()
  })

  test('picks the nearer of two competing neighbours, and reports which', () => {
    const far = { x: 100, y: 400, w: 200, h: 80 }
    // Closer to the slot below `neighbour` than to the one above `far`.
    const result = snapToNeighbours(dragged(below.x, below.y + 12), [neighbour, far], RADIUS)
    expect(point(result)).toEqual(below)
    expect(result.snappedTo).toEqual(neighbour)
  })

  test('returns the drop position unchanged when there are no neighbours', () => {
    expect(snapToNeighbours(dragged(42, 84), [], RADIUS))
      .toEqual({ x: 42, y: 84, snappedTo: null })
  })

  test('honours a gap passed explicitly over the default', () => {
    expect(point(snapToNeighbours(dragged(100, 190), [neighbour], RADIUS, 0)))
      .toEqual({ x: 100, y: 180 })
  })
})

describe('snapHalo', () => {
  test('contains both cards with padding on every side', () => {
    expect(snapHalo(
      { x: 100, y: 100, w: 200, h: 80 },
      { x: 100, y: 180 + G, w: 200, h: 60 },
      8,
    )).toEqual({ x: 92, y: 92, w: 216, h: 156 + G })
  })

  test('spans a side-by-side pair of unequal height', () => {
    expect(snapHalo(
      { x: 0, y: 0, w: 100, h: 200 },
      { x: 100 + G, y: 0, w: 100, h: 50 },
      4,
    )).toEqual({ x: -4, y: -4, w: 208 + G, h: 208 })
  })
})
