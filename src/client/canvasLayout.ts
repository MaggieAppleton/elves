import type { Editor, TLShapeId } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { QuestionShape } from '../shapes/QuestionShapeUtil'
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
