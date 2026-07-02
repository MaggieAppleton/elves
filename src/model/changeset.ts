import { CommentType } from './types'

export type Op =
  | { kind: 'add_comment'; cardId: string; comment: { type: CommentType | null; text: string } }
  | { kind: 'merge_sources'; cardIds: string[] }
  | { kind: 'move_cards'; moves: { cardId: string; x: number; y: number }[] }
  | { kind: 'create_source_card'; text: string; x: number; y: number }
  | { kind: 'create_section'; text: string; x: number; y: number }
  | { kind: 'move_sections'; moves: { sectionId: string; x: number; y: number }[] }
  | { kind: 'edit_section_text'; sectionId: string; text: string }

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
    case 'create_section':
      return typeof op.text === 'string' && typeof op.x === 'number' && typeof op.y === 'number'
    case 'move_sections':
      return Array.isArray(op.moves) && op.moves.every((m) => {
        const mm = m as Record<string, unknown>
        return typeof mm.sectionId === 'string' && typeof mm.x === 'number' && typeof mm.y === 'number'
      })
    case 'edit_section_text':
      return typeof op.sectionId === 'string' && typeof op.text === 'string'
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
 *
 * edit_section_text is a deliberate, conscious exception: section labels are
 * organizational headings, not prose or reference material, so Claude is
 * explicitly permitted to write and rename them. That permission is scoped to
 * this one op — it does not touch card text in any way.
 */
export function changeSetWritesText(cs: ChangeSet): boolean {
  return cs.ops.some((op) => {
    switch (op.kind) {
      case 'add_comment':
      case 'merge_sources':
      case 'move_cards':
      case 'create_source_card':
      case 'create_section':
      case 'move_sections':
      case 'edit_section_text':
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

/**
 * Card ids an op references as an EXISTING card (comment target, merge members,
 * move targets). create_source_card mints a new id and references nothing, so it
 * is excluded. The server uses this to reject a change-set that targets a card
 * outside the project it was posted to.
 */
export function referencedCardIds(cs: ChangeSet): string[] {
  const ids: string[] = []
  for (const op of cs.ops) {
    if (op.kind === 'add_comment') ids.push(op.cardId)
    else if (op.kind === 'merge_sources') ids.push(...op.cardIds)
    else if (op.kind === 'move_cards') ids.push(...op.moves.map((m) => m.cardId))
  }
  return ids
}

/**
 * Section ids an op references as an EXISTING section (move targets, rename
 * target). create_section mints a new id and references nothing, so it is
 * excluded — mirrors referencedCardIds for the section model.
 */
export function referencedSectionIds(cs: ChangeSet): string[] {
  const ids: string[] = []
  for (const op of cs.ops) {
    if (op.kind === 'move_sections') ids.push(...op.moves.map((m) => m.sectionId))
    else if (op.kind === 'edit_section_text') ids.push(op.sectionId)
  }
  return ids
}
