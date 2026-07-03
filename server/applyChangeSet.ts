import { createShapeId } from '@tldraw/tlschema'
import { getIndexAbove, IndexKey } from '@tldraw/utils'
import type { CanvasSnapshot } from './store'
import { ChangeSet, planMerge } from '../src/model/changeset'
import { makeComment, addComment } from '../src/model/comments'
import { makeNoteCardProps, makeReferenceCardProps } from '../src/model/cards'
import { makeSectionProps } from '../src/model/sections'
import { resolvePageXY } from './digest'

type StoreRecords = Record<string, any>

function findCardShape(store: StoreRecords, id: string): any | undefined {
  const r = store[id]
  return r && r.typeName === 'shape' && r.type === 'card' ? r : undefined
}

function findGroupShape(store: StoreRecords, id: string): any | undefined {
  const r = store[id]
  return r && r.typeName === 'shape' && r.type === 'group' ? r : undefined
}

/** Page coords of a shape's parent — the origin to subtract/add when (un)grouping. */
function parentOrigin(store: StoreRecords, shape: any): { x: number; y: number } {
  const parent = shape.parentId ? store[shape.parentId] : undefined
  return parent && parent.typeName === 'shape' ? resolvePageXY(store, parent) : { x: 0, y: 0 }
}

function findSectionShape(store: StoreRecords, id: string): any | undefined {
  const r = store[id]
  return r && r.typeName === 'shape' && r.type === 'section' ? r : undefined
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
      case 'merge_notes': {
        const { representativeId, hiddenIds } = planMerge(op.cardIds)
        for (const id of hiddenIds) {
          const shape = findCardShape(store, id)
          if (shape && shape.props.kind === 'note') shape.props.mergedInto = representativeId
        }
        break
      }
      case 'move_cards': {
        for (const m of op.moves) {
          const shape = findCardShape(store, m.cardId)
          if (shape) {
            // Claude passes absolute page coords; a grouped card stores parent-local
            // coords, so subtract its parent's page origin (a no-op for top-level cards).
            const origin = parentOrigin(store, shape)
            shape.x = m.x - origin.x
            shape.y = m.y - origin.y
          }
        }
        break
      }
      case 'create_note_card': {
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
          // Stamp the change-set's author so the persisted card keeps its mark.
          props: makeNoteCardProps(op.text, 'transcribed', cs.author),
        }
        break
      }
      case 'create_reference': {
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
          props: makeReferenceCardProps(op.reference),
        }
        break
      }
      case 'create_section': {
        const id = createShapeId()
        store[id] = {
          id,
          typeName: 'shape',
          type: 'section',
          x: op.x,
          y: op.y,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          meta: {},
          parentId: defaultPageId(store),
          index: getIndexAbove(topIndex(store)),
          props: makeSectionProps(op.text, 'claude'),
        }
        break
      }
      case 'move_sections': {
        for (const m of op.moves) {
          const shape = findSectionShape(store, m.sectionId)
          if (shape) {
            shape.x = m.x
            shape.y = m.y
          }
        }
        break
      }
      case 'edit_section_text': {
        const shape = findSectionShape(store, op.sectionId)
        if (shape) {
          shape.props.text = op.text
          shape.props.authoredBy = 'claude'
        }
        break
      }
      case 'group_cards': {
        // Replicate editor.groupShapes: group origin = top-left of members' page
        // bounds; each member reparented to page-local-minus-origin coords.
        const members = op.cardIds
          .map((id) => findCardShape(store, id))
          .filter((s): s is any => !!s)
        if (members.length < 2) break
        const pages = members.map((s) => resolvePageXY(store, s))
        const originX = Math.min(...pages.map((p) => p.x))
        const originY = Math.min(...pages.map((p) => p.y))
        const groupId = createShapeId()
        store[groupId] = {
          id: groupId,
          typeName: 'shape',
          type: 'group',
          x: originX,
          y: originY,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          meta: {},
          parentId: defaultPageId(store),
          index: getIndexAbove(topIndex(store)),
          props: {},
        }
        members.forEach((s, i) => {
          s.parentId = groupId
          s.x = pages[i].x - originX
          s.y = pages[i].y - originY
        })
        break
      }
      case 'ungroup_cards': {
        const group = findGroupShape(store, op.groupId)
        if (!group) break
        for (const r of Object.values(store) as any[]) {
          if (r?.typeName === 'shape' && r.parentId === group.id) {
            r.parentId = group.parentId
            r.x = (r.x ?? 0) + (group.x ?? 0)
            r.y = (r.y ?? 0) + (group.y ?? 0)
          }
        }
        delete store[group.id]
        break
      }
      case 'set_summary': {
        const shape = findCardShape(store, op.cardId)
        if (shape) {
          shape.props.summary = op.summary
          shape.props.summaryOfHash = op.summaryOfHash
          shape.props.summaryBy = op.summaryBy
          shape.props.summaryAt = op.summaryAt
        }
        break
      }
    }
  }
  return next
}
