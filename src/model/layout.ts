// Cascades successive spawns (new cards/sections) so they don't stack
// invisibly on top of each other when created at the viewport center.

export const CANVAS_GAP = 24
export const CASCADE_STEP = CANVAS_GAP
// Reset after this many steps so cards don't drift off-screen forever.
export const CASCADE_WRAP = 8

export interface LayoutRect {
  x: number
  y: number
  w: number
  h: number
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

export function cascadeOffset(spawnIndex: number): { dx: number; dy: number } {
  const step = spawnIndex % CASCADE_WRAP
  return { dx: step * CASCADE_STEP, dy: step * CASCADE_STEP }
}
