// Cascades successive spawns (new cards/sections) so they don't stack
// invisibly on top of each other when created at the viewport center.

export const CANVAS_GAP = 16
export const CASCADE_STEP = CANVAS_GAP
// Reset after this many steps so cards don't drift off-screen forever.
export const CASCADE_WRAP = 8

export interface LayoutRect {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutItem {
  id: string
  rect: LayoutRect
}

export interface LayoutMove {
  id: string
  x: number
  y: number
}

export function conflictsWithGap(
  a: LayoutRect,
  b: LayoutRect,
  gap = CANVAS_GAP,
): boolean {
  return a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
}

export function placeBelowObstacles(
  rect: LayoutRect,
  obstacles: LayoutRect[],
  gap = CANVAS_GAP,
): LayoutRect {
  const placed = { ...rect }
  for (let i = 0; i <= obstacles.length; i++) {
    const hits = obstacles.filter((obstacle) => conflictsWithGap(placed, obstacle, gap))
    if (hits.length === 0) break
    placed.y = Math.max(...hits.map((obstacle) => obstacle.y + obstacle.h)) + gap
  }
  return placed
}

function overlapsHorizontally(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x
}

export function reflowVerticalLane(
  anchorId: string,
  items: LayoutItem[],
  previousAnchorHeight?: number,
  gap = CANVAS_GAP,
): LayoutMove[] {
  const anchor = items.find((item) => item.id === anchorId)
  if (!anchor) return []

  const lane = items
    .filter((item) =>
      item.id !== anchorId &&
      item.rect.y >= anchor.rect.y &&
      overlapsHorizontally(anchor.rect, item.rect),
    )
    .sort((a, b) => a.rect.y - b.rect.y)
  const priorHeight = previousAnchorHeight ?? anchor.rect.h
  const shrinking = priorHeight > anchor.rect.h
  let previousCursor = anchor.rect.y + priorHeight + gap
  let cursor = anchor.rect.y + anchor.rect.h + gap
  const moves: LayoutMove[] = []

  for (const item of lane) {
    if (shrinking) {
      if (item.rect.y > previousCursor + gap) break
      if (Math.abs(item.rect.y - cursor) > 1) {
        moves.push({ id: item.id, x: item.rect.x, y: cursor })
      }
      previousCursor = item.rect.y + item.rect.h + gap
      cursor += item.rect.h + gap
      continue
    }

    if (item.rect.y > cursor) break
    if (item.rect.y < cursor) {
      moves.push({ id: item.id, x: item.rect.x, y: cursor })
    }
    cursor += item.rect.h + gap
  }

  return moves
}

export function findOverlaySlot(
  anchor: LayoutRect,
  overlay: Pick<LayoutRect, 'w' | 'h'>,
  obstacles: LayoutRect[],
  gap = CANVAS_GAP,
): LayoutRect {
  const candidates: LayoutRect[] = [
    { x: anchor.x + anchor.w + gap, y: anchor.y, ...overlay },
    { x: anchor.x - overlay.w - gap, y: anchor.y, ...overlay },
    { x: anchor.x, y: anchor.y + anchor.h + gap, ...overlay },
    { x: anchor.x, y: anchor.y - overlay.h - gap, ...overlay },
  ]
  const clear = candidates.find((candidate) =>
    obstacles.every((obstacle) => !conflictsWithGap(candidate, obstacle, gap)),
  )
  return clear ?? placeBelowObstacles(candidates[0], obstacles, gap)
}

export interface SnapResult {
  x: number
  y: number
  /** The card that was snapped to, or null when the drop position stands. */
  snappedTo: LayoutRect | null
}

/**
 * Where a card being dragged should sit if it is close enough to another card
 * to join it. Cards snap into a clean `gap` separation on one of four sides,
 * with the cross-axis edges flush — below/above align left edges, right/left
 * align top edges — which is what turns a loose pile into a column.
 *
 * This is alignment only, not grouping: the returned position is a one-time
 * placement and the two cards keep no memory of each other. Dragging further
 * than `radius` from every slot returns the drop position untouched, so
 * pulling a card out of a stack needs no gesture beyond moving it away.
 *
 * `snappedTo` reports which card was joined so the caller can show the pairing
 * while the drag is live.
 */
export function snapToNeighbours(
  dragged: LayoutRect,
  neighbours: LayoutRect[],
  radius: number,
  gap = CANVAS_GAP,
): SnapResult {
  let best: SnapResult = { x: dragged.x, y: dragged.y, snappedTo: null }
  let bestDistance = radius

  for (const neighbour of neighbours) {
    const candidates = [
      { x: neighbour.x, y: neighbour.y + neighbour.h + gap },
      { x: neighbour.x, y: neighbour.y - dragged.h - gap },
      { x: neighbour.x + neighbour.w + gap, y: neighbour.y },
      { x: neighbour.x - dragged.w - gap, y: neighbour.y },
    ]
    for (const candidate of candidates) {
      const distance = Math.hypot(candidate.x - dragged.x, candidate.y - dragged.y)
      if (distance < bestDistance) {
        best = { ...candidate, snappedTo: neighbour }
        bestDistance = distance
      }
    }
  }

  return best
}

/** The box that contains both cards of a snap, padded so it reads as a halo. */
export function snapHalo(a: LayoutRect, b: LayoutRect, pad: number): LayoutRect {
  const x = Math.min(a.x, b.x) - pad
  const y = Math.min(a.y, b.y) - pad
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) + pad - x,
    h: Math.max(a.y + a.h, b.y + b.h) + pad - y,
  }
}

export function cascadeOffset(spawnIndex: number): { dx: number; dy: number } {
  const step = spawnIndex % CASCADE_WRAP
  return { dx: step * CASCADE_STEP, dy: step * CASCADE_STEP }
}
