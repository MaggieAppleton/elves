import { createShapeId } from '@tldraw/tlschema'
import { getIndexAbove, IndexKey } from '@tldraw/utils'
import type { CanvasSnapshot } from './store'
import { ChangeSet, planMerge } from '../src/model/changeset'
import { makeComment, addComment } from '../src/model/comments'
import { makeSourceCardProps } from '../src/model/cards'

type StoreRecords = Record<string, any>

function findCardShape(store: StoreRecords, id: string): any | undefined {
  const r = store[id]
  return r && r.typeName === 'shape' && r.type === 'card' ? r : undefined
}

function defaultPageId(store: StoreRecords): string {
  const page = Object.values(store).find((r: any) => r?.typeName === 'page') as any
  return page?.id ?? 'page:page'
}

function topIndex(store: StoreRecords): IndexKey | undefined {
  let max: IndexKey | undefined
  for (const r of Object.values(store) as any[]) {
    if (r?.typeName === 'shape' && typeof r.index === 'string' && (!max || r.index > max)) {
      max = r.index as IndexKey
    }
  }
  return max
}

/**
 * Applies a change-set directly to a canvas snapshot already on disk, so
 * persistence never depends on a browser tab being open to the right project
 * (see server/app.ts's changeset handler for why that dependency was unsafe).
 *
 * Returns null when the project has no document yet (never opened in the
 * canvas UI, so no tldraw schema exists to write into) — callers should fall
 * back to broadcast-only in that case, same as before this function existed.
 */
export function applyChangeSetToSnapshot(
  snapshot: CanvasSnapshot,
  cs: ChangeSet,
): CanvasSnapshot | null {
  const doc = (snapshot as any)?.document
  if (!doc || !doc.store) return null

  const next = JSON.parse(JSON.stringify(snapshot)) as CanvasSnapshot
  const store = (next as any).document.store as StoreRecords

  for (const op of cs.ops) {
    switch (op.kind) {
      case 'add_comment': {
        const shape = findCardShape(store, op.cardId)
        if (!shape) break
        const comment = makeComment(`cmt-${crypto.randomUUID()}`, op.comment.text, op.comment.type)
        shape.props.comments = addComment(shape.props.comments ?? [], comment)
        break
      }
      case 'merge_sources': {
        const { representativeId, hiddenIds } = planMerge(op.cardIds)
        for (const id of hiddenIds) {
          const shape = findCardShape(store, id)
          if (shape && shape.props.kind === 'source') shape.props.mergedInto = representativeId
        }
        break
      }
      case 'move_cards': {
        for (const m of op.moves) {
          const shape = findCardShape(store, m.cardId)
          if (shape) {
            shape.x = m.x
            shape.y = m.y
          }
        }
        break
      }
      case 'create_source_card': {
        const id = createShapeId()
        store[id] = {
          id,
          typeName: 'shape',
          type: 'card',
          x: op.x,
          y: op.y,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          meta: {},
          parentId: defaultPageId(store),
          index: getIndexAbove(topIndex(store)),
          props: makeSourceCardProps(op.text, 'transcribed'),
        }
        break
      }
    }
  }
  return next
}
