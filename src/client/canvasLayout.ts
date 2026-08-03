import type { Editor, TLShapeId } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { QuestionShape } from '../shapes/QuestionShapeUtil'
import {
  placeBelowObstacles,
  reflowVerticalLane,
  snapToNeighbours,
  type LayoutItem,
  type LayoutRect,
} from '../model/layout'

// How close a dragged card must come to a snap slot before it is pulled in,
// measured in SCREEN pixels. A page-space radius would feel dead when zoomed
// out and grabby when zoomed in; dividing by the zoom keeps the pull constant.
export const SNAP_RADIUS_PX = 40

export function cardLayoutItems(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutItem[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is CardShape =>
      shape.type === 'card' &&
      !excludedIds.has(shape.id) &&
      !(shape as CardShape).props.mergedInto,
    )
    .map((shape) => ({ shape, bounds: editor.getShapePageBounds(shape.id) }))
    .filter((entry): entry is typeof entry & { bounds: NonNullable<typeof entry.bounds> } => !!entry.bounds)
    .map(({ shape, bounds }) => ({
      id: shape.id,
      rect: {
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h + Math.max(0, shape.props.commentH ?? 0),
      },
    }))
}

export function cardObstacles(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect[] {
  return cardLayoutItems(editor, excludedIds).map((item) => item.rect)
}

export function questionLayoutItems(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutItem[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is QuestionShape =>
      shape.type === 'question' &&
      !excludedIds.has(shape.id) &&
      !(shape as QuestionShape).props.dismissed,
    )
    .map((shape) => ({ shape, bounds: editor.getShapePageBounds(shape.id) }))
    .filter((entry): entry is typeof entry & { bounds: NonNullable<typeof entry.bounds> } => !!entry.bounds)
    .map(({ shape, bounds }) => ({
      id: shape.id,
      rect: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    }))
}

export function canvasObstacles(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect[] {
  return canvasLayoutItems(editor, excludedIds).map((item) => item.rect)
}

export function canvasLayoutItems(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutItem[] {
  return [
    ...cardLayoutItems(editor, excludedIds),
    ...questionLayoutItems(editor, excludedIds),
  ]
}

export function clearCardPosition(
  editor: Editor,
  rect: LayoutRect,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect {
  return placeBelowObstacles(rect, canvasObstacles(editor, excludedIds))
}

export interface SnappedPosition {
  /** Parent-space, ready to hand back to tldraw as the shape's x/y. */
  x: number
  y: number
  /** The same point in page space, for drawing the halo. */
  page: { x: number; y: number }
  /** The card that was joined, or null when the drop position stands. */
  snappedTo: LayoutRect | null
}

/**
 * The position a card being dragged should take, snapped to a neighbouring
 * card or question when one is within reach. Returns the point unchanged when
 * nothing is close enough, so a card dragged clear of a stack simply stops
 * snapping.
 */
export function snapCardPosition(
  editor: Editor,
  id: TLShapeId,
  pageRect: LayoutRect,
): SnappedPosition {
  const snapped = snapToNeighbours(
    pageRect,
    canvasObstacles(editor, new Set([id])),
    SNAP_RADIUS_PX / editor.getZoomLevel(),
  )
  const local = editor.getPointInParentSpace(id, snapped)
  return {
    x: local.x,
    y: local.y,
    page: { x: snapped.x, y: snapped.y },
    snappedTo: snapped.snappedTo,
  }
}

export function reflowCanvasLane(
  editor: Editor,
  anchorId: TLShapeId,
  previousAnchorHeight: number,
): TLShapeId[] {
  const shifted: TLShapeId[] = []
  for (const move of reflowVerticalLane(
    anchorId,
    canvasLayoutItems(editor),
    previousAnchorHeight,
  )) {
    const shape = editor.getShape(move.id as TLShapeId)
    if (!shape || (shape.type !== 'card' && shape.type !== 'question')) continue
    const local = editor.getPointInParentSpace(shape.id, { x: move.x, y: move.y })
    editor.updateShape({ id: shape.id, type: shape.type, x: local.x, y: local.y })
    shifted.push(shape.id)
  }
  return shifted
}

export function reflowCardLane(
  editor: Editor,
  anchorId: CardShape['id'],
  previousAnchorHeight: number,
): TLShapeId[] {
  return reflowCanvasLane(editor, anchorId, previousAnchorHeight)
}
