import type { Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import {
  placeBelowObstacles,
  reflowVerticalLane,
  type LayoutItem,
  type LayoutRect,
} from '../model/layout'

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

export function clearCardPosition(
  editor: Editor,
  rect: LayoutRect,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect {
  return placeBelowObstacles(rect, cardObstacles(editor, excludedIds))
}

export function reflowCardLane(
  editor: Editor,
  anchorId: CardShape['id'],
  previousAnchorHeight: number,
): CardShape['id'][] {
  const shifted: CardShape['id'][] = []
  for (const move of reflowVerticalLane(
    anchorId,
    cardLayoutItems(editor),
    previousAnchorHeight,
  )) {
    const shape = editor.getShape(move.id as CardShape['id']) as CardShape | undefined
    if (!shape) continue
    const local = editor.getPointInParentSpace(shape.id, { x: move.x, y: move.y })
    editor.updateShape({ id: shape.id, type: 'card', x: local.x, y: local.y })
    shifted.push(shape.id)
  }
  return shifted
}
