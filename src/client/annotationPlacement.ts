export interface AnnotationRect { left: number; top: number; width: number; height: number }
export interface AnnotationViewport { left: number; top: number; width: number; height: number }
export type AnnotationPlacementSide = 'right' | 'left' | 'above' | 'below'
export interface AnnotationPlacement { left: number; top: number; side: AnnotationPlacementSide }

export interface AnnotationPlacementOptions {
  source?: AnnotationRect
  obstacles?: AnnotationRect[]
  preferredSide?: AnnotationPlacementSide
}

export interface AnnotationArrangementItem {
  key: string
  anchor: AnnotationRect
  source: AnnotationRect
  thread: Pick<AnnotationRect, 'width' | 'height'>
  preferredSide?: AnnotationPlacementSide
  /** A pointer preview may expand without jumping when its former position is still safe. */
  preservePlacement?: AnnotationPlacement
}

const GAP = 12
const EDGE = 8
const VISIBLE_EDGE = 32
const SIDES: AnnotationPlacementSide[] = ['right', 'left', 'above', 'below']

/** Keep an anchored foreground surface within the same inset as its placement. */
export function annotationThreadMaxHeight(stageHeight: number): number {
  return Math.max(0, stageHeight - EDGE * 2)
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

function rectRight(rect: AnnotationRect): number { return rect.left + rect.width }
function rectBottom(rect: AnnotationRect): number { return rect.top + rect.height }

function intersectionArea(left: AnnotationRect, right: AnnotationRect): number {
  return Math.max(0, Math.min(rectRight(left), rectRight(right)) - Math.max(left.left, right.left)) *
    Math.max(0, Math.min(rectBottom(left), rectBottom(right)) - Math.max(left.top, right.top))
}

function viewportOverflow(rect: AnnotationRect, viewport: AnnotationViewport): number {
  return Math.max(0, viewport.left + EDGE - rect.left) +
    Math.max(0, viewport.top + EDGE - rect.top) +
    Math.max(0, rectRight(rect) - (viewport.left + viewport.width - EDGE)) +
    Math.max(0, rectBottom(rect) - (viewport.top + viewport.height - EDGE))
}

function clampedPosition(
  left: number,
  top: number,
  thread: Pick<AnnotationRect, 'width' | 'height'>,
  viewport: AnnotationViewport,
): Pick<AnnotationRect, 'left' | 'top'> {
  const wide = thread.width + EDGE * 2 > viewport.width
  const tall = thread.height + EDGE * 2 > viewport.height
  return {
    left: clamp(left, wide ? viewport.left : viewport.left + EDGE,
      wide ? viewport.left : viewport.left + viewport.width - thread.width - EDGE),
    top: clamp(top, tall ? viewport.top : viewport.top + EDGE,
      tall ? viewport.top : viewport.top + viewport.height - thread.height - EDGE),
  }
}

interface Candidate extends AnnotationPlacement {
  sourceIntersection: number
  overflow: number
  obstacleIntersection: number
  pinDistance: number
  order: number
}

function candidatePositions(
  side: AnnotationPlacementSide,
  anchor: AnnotationRect,
  source: AnnotationRect,
  thread: Pick<AnnotationRect, 'width' | 'height'>,
  obstacles: AnnotationRect[],
): Array<{ left: number; top: number }> {
  const vertical = side === 'right' || side === 'left'
  const baseLeft = side === 'right' ? rectRight(source) + GAP
    : side === 'left' ? source.left - thread.width - GAP
      : anchor.left + (anchor.width - thread.width) / 2
  const baseTop = side === 'below' ? rectBottom(source) + GAP
    : side === 'above' ? source.top - thread.height - GAP
      : anchor.top
  const values = vertical
    ? [baseTop, ...obstacles.flatMap((obstacle) => [
      obstacle.top - thread.height - GAP,
      rectBottom(obstacle) + GAP,
      obstacle.top + VISIBLE_EDGE,
      rectBottom(obstacle) - thread.height - VISIBLE_EDGE,
    ])]
    : [baseLeft, ...obstacles.flatMap((obstacle) => [
      obstacle.left - thread.width - GAP,
      rectRight(obstacle) + GAP,
      obstacle.left + VISIBLE_EDGE,
      rectRight(obstacle) - thread.width - VISIBLE_EDGE,
    ])]
  return [...new Set(values)].map((value) => vertical
    ? { left: baseLeft, top: value }
    : { left: value, top: baseTop })
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.sourceIntersection - right.sourceIntersection ||
    left.overflow - right.overflow ||
    left.obstacleIntersection - right.obstacleIntersection ||
    left.pinDistance - right.pinDistance ||
    left.order - right.order
}

/** Score source readability before viewport fit, panel collisions, and pin distance. */
export function placeAnnotationThread(
  anchor: AnnotationRect,
  thread: Pick<AnnotationRect, 'width' | 'height'>,
  viewport: AnnotationViewport,
  options: AnnotationPlacementOptions = {},
): AnnotationPlacement {
  const source = options.source ?? anchor
  const obstacles = options.obstacles ?? []
  const build = (side: AnnotationPlacementSide, orderOffset: number): Candidate[] =>
    candidatePositions(side, anchor, source, thread, obstacles).map((raw, index) => {
      const position = clampedPosition(raw.left, raw.top, thread, viewport)
      const rect = { ...position, ...thread }
      const pinCenterX = anchor.left + anchor.width / 2
      const pinCenterY = anchor.top + anchor.height / 2
      const threadCenterX = rect.left + rect.width / 2
      const threadCenterY = rect.top + rect.height / 2
      return {
        ...position,
        side,
        sourceIntersection: intersectionArea(rect, source),
        overflow: viewportOverflow(rect, viewport),
        obstacleIntersection: obstacles.reduce((total, obstacle) => total + intersectionArea(rect, obstacle), 0),
        pinDistance: Math.hypot(threadCenterX - pinCenterX, threadCenterY - pinCenterY),
        order: orderOffset + index,
      }
    })

  let candidates = SIDES.flatMap((side, index) => build(side, index * 10_000))
  if (options.preferredSide) {
    const preferred = candidates.filter((candidate) => candidate.side === options.preferredSide)
    if (preferred.some((candidate) => candidate.sourceIntersection === 0 && candidate.overflow === 0)) {
      candidates = preferred
    }
  }
  const winner = candidates.sort(compareCandidates)[0]
  return { left: winner.left, top: winner.top, side: winner.side }
}

/** Items are ordered from highest to lowest priority; lower panels avoid earlier ones. */
export function arrangeAnnotationThreads(
  items: AnnotationArrangementItem[],
  viewport: AnnotationViewport,
): Record<string, AnnotationPlacement> {
  const placements: Record<string, AnnotationPlacement> = {}
  const obstacles: AnnotationRect[] = []
  for (const item of items) {
    const preserved = item.preservePlacement && { ...item.preservePlacement, ...item.thread }
    if (preserved &&
      intersectionArea(preserved, item.source) === 0 &&
      viewportOverflow(preserved, viewport) === 0 &&
      obstacles.every((obstacle) => intersectionArea(preserved, obstacle) === 0)) {
      placements[item.key] = item.preservePlacement!
      obstacles.push(preserved)
      continue
    }
    const placement = placeAnnotationThread(item.anchor, item.thread, viewport, {
      source: item.source,
      obstacles,
      preferredSide: item.preferredSide,
    })
    placements[item.key] = placement
    obstacles.push({ ...placement, ...item.thread })
  }
  return placements
}
