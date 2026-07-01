import { CommentType } from './types'

export type Op =
  | { kind: 'add_comment'; cardId: string; comment: { type: CommentType | null; text: string } }
  | { kind: 'merge_sources'; cardIds: string[] }
  | { kind: 'move_cards'; moves: { cardId: string; x: number; y: number }[] }
  | { kind: 'create_source_card'; text: string; x: number; y: number }

export interface ChangeSet {
  id: string
  author: 'claude'
  ops: Op[]
}

const COMMENT_TYPES: readonly (CommentType | null)[] = [
  'needs-evidence', 'weak-argument', 'needs-citation', null,
]

function isOp(v: unknown): v is Op {
  if (typeof v !== 'object' || v === null) return false
  const op = v as Record<string, unknown>
  switch (op.kind) {
    case 'add_comment': {
      const c = op.comment as Record<string, unknown> | undefined
      return typeof op.cardId === 'string' && !!c &&
        typeof c.text === 'string' && COMMENT_TYPES.includes(c.type as CommentType | null)
    }
    case 'merge_sources':
      return Array.isArray(op.cardIds) && op.cardIds.every((id) => typeof id === 'string')
    case 'move_cards':
      return Array.isArray(op.moves) && op.moves.every((m) => {
        const mm = m as Record<string, unknown>
        return typeof mm.cardId === 'string' && typeof mm.x === 'number' && typeof mm.y === 'number'
      })
    case 'create_source_card':
      return typeof op.text === 'string' && typeof op.x === 'number' && typeof op.y === 'number'
    default:
      return false
  }
}

export function isChangeSet(value: unknown): value is ChangeSet {
  if (typeof value !== 'object' || value === null) return false
  const cs = value as Record<string, unknown>
  return typeof cs.id === 'string' && cs.author === 'claude' &&
    Array.isArray(cs.ops) && cs.ops.every(isOp)
}

/**
 * Defense-in-depth for the core rule "Claude never writes prose". Returns true
 * iff any op in the change-set would write prose text or edit an existing card's text.
 * create_source_card creates a new source card (allowed), so it returns false for it.
 * The server calls this before applying, so if a text-writing op is ever added it must
 * be added here consciously.
 */
export function changeSetWritesText(cs: ChangeSet): boolean {
  return cs.ops.some((op) => {
    switch (op.kind) {
      case 'add_comment':
      case 'merge_sources':
      case 'move_cards':
      case 'create_source_card':
        return false
      default:
        return true // unknown op: treat as unsafe
    }
  })
}

export interface MergePlan {
  representativeId: string
  hiddenIds: string[]
}

export function planMerge(cardIds: string[]): MergePlan {
  const representativeId = cardIds[0]
  const hiddenIds = [...new Set(cardIds.slice(1))].filter((id) => id !== representativeId)
  return { representativeId, hiddenIds }
}
