import { CommentType, Reference, RefType } from './types'

export type Op =
  | { kind: 'add_comment'; cardId: string; comment: { type: CommentType | null; text: string } }
  | { kind: 'merge_notes'; cardIds: string[] }
  | { kind: 'move_cards'; moves: { cardId: string; x: number; y: number }[] }
  | { kind: 'create_note_card'; text: string; x: number; y: number }
  | { kind: 'create_reference'; reference: Reference; x: number; y: number }
  | { kind: 'create_section'; text: string; x: number; y: number }
  | { kind: 'create_figure_card'; title: string; description: string; x: number; y: number }
  | { kind: 'move_sections'; moves: { sectionId: string; x: number; y: number }[] }
  | { kind: 'edit_section_text'; sectionId: string; text: string }
  | { kind: 'group_cards'; cardIds: string[] }
  | { kind: 'ungroup_cards'; groupId: string }
  | {
      kind: 'set_summary'
      cardId: string
      summary: string | null
      summaryOfHash: string | null
      summaryBy: string | null
      summaryAt: string | null
    }

const REF_TYPES: readonly RefType[] = [
  'paper', 'article', 'book', 'software', 'social', 'video', 'wiki', 'link',
]
const REF_FETCHERS: readonly (Reference['fetchedBy'])[] = ['unfurl', 'claude', 'user', null]

function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === 'string'
}

/** Structural validation for a Reference carried by a create_reference op. */
export function isReference(v: unknown): v is Reference {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.url === 'string' &&
    REF_TYPES.includes(r.refType as RefType) &&
    isStringOrNull(r.title) &&
    Array.isArray(r.authors) && r.authors.every((a) => typeof a === 'string') &&
    isStringOrNull(r.siteName) &&
    (r.year === null || typeof r.year === 'number') &&
    isStringOrNull(r.venue) &&
    isStringOrNull(r.description) &&
    isStringOrNull(r.faviconAssetId) &&
    isStringOrNull(r.thumbnailAssetId) &&
    isStringOrNull(r.doi) &&
    isStringOrNull(r.arxivId) &&
    REF_FETCHERS.includes(r.fetchedBy as Reference['fetchedBy']) &&
    isStringOrNull(r.fetchedAt)
  )
}

export interface ChangeSet {
  id: string
  /**
   * The agent that authored this change-set, as an agent id (e.g. 'claude').
   * Open string, not a literal, so a new agent's MCP server can stamp its own id
   * (see ELVES_AGENT). A create_note_card stamps this onto the new card's
   * `authoredBy`, which drives its authorship mark.
   */
  author: string
  ops: Op[]
}

const COMMENT_TYPES: readonly (CommentType | null)[] = [
  'needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure', null,
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
    case 'merge_notes':
      return Array.isArray(op.cardIds) && op.cardIds.every((id) => typeof id === 'string')
    case 'move_cards':
      return Array.isArray(op.moves) && op.moves.every((m) => {
        const mm = m as Record<string, unknown>
        return typeof mm.cardId === 'string' && typeof mm.x === 'number' && typeof mm.y === 'number'
      })
    case 'create_note_card':
      return typeof op.text === 'string' && typeof op.x === 'number' && typeof op.y === 'number'
    case 'create_reference':
      return isReference(op.reference) && typeof op.x === 'number' && typeof op.y === 'number'
    case 'create_section':
      return typeof op.text === 'string' && typeof op.x === 'number' && typeof op.y === 'number'
    case 'create_figure_card':
      return typeof op.title === 'string' && typeof op.description === 'string' &&
        typeof op.x === 'number' && typeof op.y === 'number'
    case 'move_sections':
      return Array.isArray(op.moves) && op.moves.every((m) => {
        const mm = m as Record<string, unknown>
        return typeof mm.sectionId === 'string' && typeof mm.x === 'number' && typeof mm.y === 'number'
      })
    case 'edit_section_text':
      return typeof op.sectionId === 'string' && typeof op.text === 'string'
    case 'group_cards':
      return Array.isArray(op.cardIds) && op.cardIds.length >= 2 &&
        op.cardIds.every((id) => typeof id === 'string')
    case 'ungroup_cards':
      return typeof op.groupId === 'string'
    case 'set_summary':
      return typeof op.cardId === 'string' &&
        isStringOrNull(op.summary) && isStringOrNull(op.summaryOfHash) &&
        isStringOrNull(op.summaryBy) && isStringOrNull(op.summaryAt)
    default:
      return false
  }
}

export function isChangeSet(value: unknown): value is ChangeSet {
  if (typeof value !== 'object' || value === null) return false
  const cs = value as Record<string, unknown>
  return typeof cs.id === 'string' && typeof cs.author === 'string' && cs.author.length > 0 &&
    Array.isArray(cs.ops) && cs.ops.every(isOp)
}

/**
 * Defense-in-depth for the core rule "Claude never writes prose". Returns true
 * iff any op in the change-set would write prose text or edit an existing card's text.
 * create_note_card creates a new note card (allowed), so it returns false for it.
 * The server calls this before applying, so if a text-writing op is ever added it must
 * be added here consciously.
 *
 * edit_section_text is a deliberate, conscious exception: section labels are
 * organizational headings, not prose or reference material, so Claude is
 * explicitly permitted to write and rename them. That permission is scoped to
 * this one op — it does not touch card text in any way.
 *
 * create_reference is likewise allowed: it creates a new note card carrying
 * structured bibliographic *facts* (the reference object) with an EMPTY
 * annotation `text`. It writes reference material and metadata, never the user's
 * own words — the same side of the boundary as create_note_card.
 *
 * set_summary is likewise a deliberate exception: it writes a model-authored
 * GIST *about* a card into the card's separate `summary` field. Like a comment
 * or a section label, it is a machine annotation, never the user's prose or the
 * card's own `text` — which it does not touch. Scoped to this one op.
 *
 * group_cards / ungroup_cards are purely structural — they bind cards to travel
 * together (a tldraw group) and never touch any card's `text`. Same safety class
 * as move_cards.
 *
 * create_figure_card is a deliberate, conscious exception in the same class as
 * create_section: a figure card is a PLACEHOLDER PLAN for a visual — a working
 * title and a description of what the visual needs to show. That description is
 * an annotation about a planned illustration, not the user's prose or reference
 * material — a figure card holds no prose the user is writing. Claude may suggest
 * one as a placeholder the user refines or rejects (it renders with the agent
 * authorship mark), the same way it may write a section label. Scoped to this one
 * op; it never touches an existing card's `text`.
 */
export function changeSetWritesText(cs: ChangeSet): boolean {
  return cs.ops.some((op) => {
    switch (op.kind) {
      case 'add_comment':
      case 'merge_notes':
      case 'move_cards':
      case 'create_note_card':
      case 'create_reference':
      case 'create_section':
      case 'create_figure_card':
      case 'move_sections':
      case 'edit_section_text':
      case 'group_cards':
      case 'ungroup_cards':
      case 'set_summary':
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
 * move targets). create_note_card mints a new id and references nothing, so it
 * is excluded. The server uses this to reject a change-set that targets a card
 * outside the project it was posted to.
 */
export function referencedCardIds(cs: ChangeSet): string[] {
  const ids: string[] = []
  for (const op of cs.ops) {
    if (op.kind === 'add_comment') ids.push(op.cardId)
    else if (op.kind === 'merge_notes') ids.push(...op.cardIds)
    else if (op.kind === 'move_cards') ids.push(...op.moves.map((m) => m.cardId))
    else if (op.kind === 'group_cards') ids.push(...op.cardIds)
    else if (op.kind === 'set_summary') ids.push(op.cardId)
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
