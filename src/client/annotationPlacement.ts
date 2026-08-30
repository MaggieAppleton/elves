export interface AnnotationRect { left: number; top: number; width: number; height: number }
export interface AnnotationViewport { left: number; top: number; width: number; height: number }
export interface AnnotationPlacement { left: number; top: number; side: 'left' | 'right' }

const GAP = 12
const EDGE = 8

export function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

export function placeAnnotationThread(
  anchor: AnnotationRect,
  thread: Pick<AnnotationRect, 'width' | 'height'>,
  viewport: AnnotationViewport,
): AnnotationPlacement {
  const normalLeft = anchor.left - thread.width - GAP
  const rightLeft = anchor.left + anchor.width + GAP
  const leftFits = normalLeft >= viewport.left + EDGE
  const side = leftFits ? 'left' : 'right'
  const preferredLeft = leftFits ? normalLeft : rightLeft
  const minLeft = thread.width + EDGE * 2 > viewport.width ? viewport.left : viewport.left + EDGE
  const maxLeft = thread.width + EDGE * 2 > viewport.width
    ? viewport.left
    : viewport.left + viewport.width - thread.width - EDGE
  const minTop = thread.height + EDGE * 2 > viewport.height ? viewport.top : viewport.top + EDGE
  const maxTop = thread.height + EDGE * 2 > viewport.height
    ? viewport.top
    : viewport.top + viewport.height - thread.height - EDGE
  return {
    side,
    left: clamp(preferredLeft, minLeft, maxLeft),
    top: clamp(anchor.top, minTop, maxTop),
  }
}
