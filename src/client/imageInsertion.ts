import { createShapeId, type Editor, type TLParentId } from 'tldraw'
import { makeImageNoteCardProps } from '../model/cards'
import { IMAGE_ASSET_MIME_TYPES, MAX_IMAGE_ASSET_BYTES } from '../model/imageAssets'
import { CANVAS_GAP, type LayoutRect } from '../model/layout'
import type { CardShape } from '../shapes/CardShapeUtil'
import { clearCardPosition } from './canvasLayout'
import { uploadAsset } from './assets'

const IMAGE_WIDTH = 280
const supportedImageMimeTypes = new Set<string>(IMAGE_ASSET_MIME_TYPES)

export interface CanvasImageInsertionPlacement {
  kind: 'canvas'
  /** Page-space centre for the first image. */
  point: { x: number; y: number }
  avoidObstacles: boolean
}

export interface DraftImageInsertionPlacement {
  kind: 'draft'
  /** Stable identity for the draft block containing this gap. */
  sectionId: string | null
  /** Neighbours at the time the user chose the gap. */
  beforeId: string | null
  afterId: string | null
  /** Used only when the draft is empty. */
  fallbackPoint: { x: number; y: number }
}

export type ImageInsertionPlacement =
  | CanvasImageInsertionPlacement
  | DraftImageInsertionPlacement
  | ResolvedDraftImageInsertionPlacement

export interface ResolvedDraftImageInsertionPlacement {
  kind: 'draft'
  /** Current draft-block item ids in narrative order. */
  itemIds: string[]
  /** Gap index: 0 is before the first item; length is after the last. */
  index: number
  fallbackPoint: { x: number; y: number }
}

export interface ImageInsertionContext {
  canvas: ImageInsertionCanvas
  projectId: string
  /** Throws when this async insertion no longer owns the active project. */
  assertCurrent(): void
  /** Resolve a semantic draft gap immediately before canvas materialization. */
  resolveDraftPlacement?(
    placement: DraftImageInsertionPlacement,
  ): ResolvedDraftImageInsertionPlacement
}

export interface ImageInsertionCard {
  id: string
  parentId: TLParentId
  bounds: LayoutRect
}

export interface ImageInsertionCanvas {
  card(id: string): ImageInsertionCard | null
  clearPosition(rect: LayoutRect): LayoutRect
  createImage(input: {
    assetId: string
    size: { w: number; h: number }
    pagePoint: { x: number; y: number }
    parent?: Pick<ImageInsertionCard, 'id' | 'parentId'>
  }): string
  moveCard(id: string, pagePoint: { x: number; y: number }): void
  select(ids: string[]): void
  transaction(run: () => void): void
}

/** Adapt tldraw's broad Editor interface to the spatial operations insertion needs. */
export function createImageInsertionCanvas(editor: Editor): ImageInsertionCanvas {
  return {
    card(rawId) {
      const id = rawId as CardShape['id']
      const shape = editor.getShape<CardShape>(id)
      const bounds = shape && editor.getShapePageBounds(id)
      if (!shape || !bounds || shape.type !== 'card') return null
      return {
        id,
        parentId: shape.parentId,
        bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
      }
    },
    clearPosition: (rect) => clearCardPosition(editor, rect),
    createImage({ assetId, size, pagePoint, parent }) {
      const id = createShapeId()
      const local = parent
        ? editor.getPointInParentSpace(parent.id as CardShape['id'], pagePoint)
        : pagePoint
      editor.createShape<CardShape>({
        id,
        type: 'card',
        ...(parent ? { parentId: parent.parentId } : {}),
        x: local.x,
        y: local.y,
        props: { ...makeImageNoteCardProps(assetId), ...size },
      })
      return id
    },
    moveCard(rawId, pagePoint) {
      const id = rawId as CardShape['id']
      const shape = editor.getShape<CardShape>(id)
      if (!shape || shape.type !== 'card') return
      const local = editor.getPointInParentSpace(id, pagePoint)
      editor.updateShape<CardShape>({ id, type: 'card', x: local.x, y: local.y })
    },
    select: (ids) => editor.select(...ids as CardShape['id'][]),
    transaction: (run) => { editor.run(run) },
  }
}

export interface ImageInsertionFailure {
  fileName: string
  message: string
}

export interface ImageInsertionResult {
  createdIds: string[]
  failures: ImageInsertionFailure[]
}

export function imageInsertionError(result: ImageInsertionResult): string | null {
  const count = result.failures.length
  if (count === 0) return null
  return `${count} image${count === 1 ? '' : 's'} could not be added: ${result.failures[0].message}`
}

async function imageSize(file: File): Promise<{ w: number; h: number }> {
  let aspect = 0.7
  try {
    const bitmap = await createImageBitmap(file)
    if (bitmap.width > 0) aspect = bitmap.height / bitmap.width
    bitmap.close?.()
  } catch {
    // Some browsers cannot decode every server-supported format. The image can
    // still be stored and rendered, so use the established fallback ratio.
  }
  return { w: IMAGE_WIDTH, h: Math.max(80, Math.round(IMAGE_WIDTH * aspect)) }
}

function validationMessage(file: File): string | null {
  if (!supportedImageMimeTypes.has(file.type)) return 'Unsupported image format'
  if (file.size === 0) return 'Image is empty'
  if (file.size > MAX_IMAGE_ASSET_BYTES) return 'Image is larger than 25 MB'
  return null
}

function shiftDraftItems(canvas: ImageInsertionCanvas, ids: string[], deltaY: number): void {
  for (const id of ids) {
    const card = canvas.card(id)
    if (!card) continue
    canvas.moveCard(id, { x: card.bounds.x, y: card.bounds.y + deltaY })
  }
}

/** Upload image files and materialize their persistent image cards. */
export async function insertImages(
  context: ImageInsertionContext,
  files: Iterable<File>,
  placement: ImageInsertionPlacement,
): Promise<ImageInsertionResult> {
  const createdIds: string[] = []
  const failures: ImageInsertionFailure[] = []
  const initialDraftPlacement = placement.kind === 'draft' && 'itemIds' in placement
    ? placement
    : null
  const draftIds = initialDraftPlacement ? [...initialDraftPlacement.itemIds] : []
  let draftIndex = initialDraftPlacement
    ? Math.max(0, Math.min(initialDraftPlacement.index, draftIds.length))
    : 0
  let previousCanvasRect: LayoutRect | null = null

  for (const file of files) {
    const invalid = validationMessage(file)
    if (invalid) {
      failures.push({ fileName: file.name, message: invalid })
      continue
    }

    context.assertCurrent()
    const size = await imageSize(file)
    context.assertCurrent()
    let assetId: string
    try {
      assetId = await uploadAsset(context.projectId, file)
    } catch (error) {
      failures.push({
        fileName: file.name,
        message: error instanceof Error ? error.message : 'Image upload failed',
      })
      continue
    }
    context.assertCurrent()

    let id: string
    if (placement.kind === 'canvas') {
      let rect: LayoutRect = previousCanvasRect
        ? {
            x: previousCanvasRect.x,
            y: previousCanvasRect.y + previousCanvasRect.h + CANVAS_GAP,
            ...size,
          }
        : {
            x: placement.point.x - size.w / 2,
            y: placement.point.y - size.h / 2,
            ...size,
          }
      if (!previousCanvasRect && placement.avoidObstacles) {
        rect = context.canvas.clearPosition(rect)
      }
      id = context.canvas.createImage({ assetId, size, pagePoint: { x: rect.x, y: rect.y } })
      previousCanvasRect = rect
    } else {
      const currentDraftPlacement = 'itemIds' in placement
        ? { itemIds: draftIds, index: draftIndex, fallbackPoint: placement.fallbackPoint }
        : context.resolveDraftPlacement?.(placement)
      if (!currentDraftPlacement) {
        throw new Error('Draft placement resolver is unavailable')
      }
      const currentIds = currentDraftPlacement.itemIds
      const currentIndex = Math.max(0, Math.min(currentDraftPlacement.index, currentIds.length))
      const previousId = currentIds[currentIndex - 1]
      const nextId = currentIds[currentIndex]
      const anchorId = previousId ?? nextId
      const anchor = anchorId ? context.canvas.card(anchorId) : null
      const anchorBounds = anchor?.bounds

      if (!anchor || !anchorBounds) {
        const rect = context.canvas.clearPosition({
          x: placement.fallbackPoint.x - size.w / 2,
          y: placement.fallbackPoint.y - size.h / 2,
          ...size,
        })
        id = context.canvas.createImage({ assetId, size, pagePoint: { x: rect.x, y: rect.y } })
      } else {
        const pagePoint = previousId
          ? {
              x: anchorBounds.x + (anchorBounds.w - size.w) / 2,
              y: anchorBounds.y + anchorBounds.h + CANVAS_GAP,
            }
          : {
              x: anchorBounds.x + (anchorBounds.w - size.w) / 2,
              y: anchorBounds.y,
            }
        const laterIds = currentIds.slice(currentIndex)
        context.canvas.transaction(() => {
          shiftDraftItems(context.canvas, laterIds, size.h + CANVAS_GAP)
          id = context.canvas.createImage({
            assetId,
            size,
            pagePoint,
            parent: { id: anchor.id, parentId: anchor.parentId },
          })
        })
      }
      if ('itemIds' in placement) {
        draftIds.splice(draftIndex, 0, id!)
        draftIndex += 1
      }
    }
    createdIds.push(id!)
  }

  if (createdIds.length) context.canvas.select(createdIds)
  return { createdIds, failures }
}
