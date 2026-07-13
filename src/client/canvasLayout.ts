import type { Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import {
  placeBelowObstacles,
  type LayoutRect,
} from '../model/layout'

export function cardObstacles(
  editor: Editor,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is CardShape =>
      shape.type === 'card' &&
      !excludedIds.has(shape.id) &&
      !(shape as CardShape).props.mergedInto,
    )
    .map((shape) => editor.getShapePageBounds(shape.id))
    .filter((bounds): bounds is NonNullable<typeof bounds> => !!bounds)
    .map((bounds) => ({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }))
}

export function clearCardPosition(
  editor: Editor,
  rect: LayoutRect,
  excludedIds: ReadonlySet<string> = new Set(),
): LayoutRect {
  return placeBelowObstacles(rect, cardObstacles(editor, excludedIds))
}
