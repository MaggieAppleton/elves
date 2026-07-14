import { createHash } from 'node:crypto'
import type { ChangeSet, Op } from '../src/model/changeset'

export const MAX_CHANGE_SET_OPS = 512
export const MAX_CHANGE_SET_ARRAY_ITEMS = 2_048
export const MAX_CHANGE_SET_NESTING_DEPTH = 16
export const MAX_CHANGE_SET_SEMANTIC_BYTES = 1_000_000

type BoundsFailure = {
  ok: false
  code: 'too-many-ops' | 'array-too-large' | 'too-deep' | 'too-large'
}

function projectReference(reference: Extract<Op, { kind: 'create_reference' }>['reference']) {
  return {
    url: reference.url,
    refType: reference.refType,
    title: reference.title,
    authors: reference.authors.map((author) => author),
    siteName: reference.siteName,
    year: reference.year,
    venue: reference.venue,
    description: reference.description,
    faviconAssetId: reference.faviconAssetId,
    thumbnailAssetId: reference.thumbnailAssetId,
    doi: reference.doi,
    arxivId: reference.arxivId,
    fetchedBy: reference.fetchedBy,
    fetchedAt: reference.fetchedAt,
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported change-set operation: ${JSON.stringify(value)}`)
}

function projectOp(op: Op): Op {
  switch (op.kind) {
    case 'add_comment':
      return {
        kind: 'add_comment',
        cardId: op.cardId,
        comment: {
          type: op.comment.type,
          text: op.comment.text,
          reviewId: op.comment.reviewId ?? null,
        },
      }
    case 'merge_notes':
      return { kind: 'merge_notes', cardIds: op.cardIds.map((cardId) => cardId) }
    case 'move_cards':
      return {
        kind: 'move_cards',
        moves: op.moves.map(({ cardId, x, y }) => ({ cardId, x, y })),
      }
    case 'create_note_card':
      return { kind: 'create_note_card', text: op.text, x: op.x, y: op.y }
    case 'create_reference':
      return {
        kind: 'create_reference',
        reference: projectReference(op.reference),
        x: op.x,
        y: op.y,
      }
    case 'create_section':
      return { kind: 'create_section', text: op.text, x: op.x, y: op.y }
    case 'create_figure_card':
      return {
        kind: 'create_figure_card',
        title: op.title,
        description: op.description,
        x: op.x,
        y: op.y,
      }
    case 'edit_card':
      return { kind: 'edit_card', cardId: op.cardId, text: op.text, title: op.title }
    case 'delete_card':
      return { kind: 'delete_card', cardId: op.cardId }
    case 'move_sections':
      return {
        kind: 'move_sections',
        moves: op.moves.map(({ sectionId, x, y }) => ({ sectionId, x, y })),
      }
    case 'edit_section_text':
      return { kind: 'edit_section_text', sectionId: op.sectionId, text: op.text }
    case 'create_question':
      return { kind: 'create_question', text: op.text, x: op.x, y: op.y }
    case 'group_cards':
      return { kind: 'group_cards', cardIds: op.cardIds.map((cardId) => cardId) }
    case 'ungroup_cards':
      return { kind: 'ungroup_cards', groupId: op.groupId }
    case 'set_summary':
      return {
        kind: 'set_summary',
        cardId: op.cardId,
        summary: op.summary,
        summaryOfHash: op.summaryOfHash,
        summaryBy: op.summaryBy,
        summaryAt: op.summaryAt,
      }
    case 'set_comment_summary':
      return {
        kind: 'set_comment_summary',
        cardId: op.cardId,
        commentId: op.commentId,
        summary: op.summary,
        summaryOfHash: op.summaryOfHash,
        summaryBy: op.summaryBy,
        summaryAt: op.summaryAt,
      }
    case 'set_question_summary':
      return {
        kind: 'set_question_summary',
        questionId: op.questionId,
        summary: op.summary,
        summaryOfHash: op.summaryOfHash,
        summaryBy: op.summaryBy,
        summaryAt: op.summaryAt,
      }
    default:
      return assertNever(op)
  }
}

export function semanticChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    id: changeSet.id,
    author: changeSet.author,
    ops: changeSet.ops.map(projectOp),
  }
}

export function semanticChangeSetJson(changeSet: ChangeSet): string {
  return JSON.stringify(semanticChangeSet(changeSet))
}

export function changeSetDigest(changeSet: ChangeSet): string {
  return createHash('sha256').update(semanticChangeSetJson(changeSet)).digest('hex')
}

function structuralBounds(value: unknown): BoundsFailure | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth > MAX_CHANGE_SET_NESTING_DEPTH) {
      return { ok: false, code: 'too-deep' }
    }
    if (typeof current.value !== 'object' || current.value === null) continue
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_CHANGE_SET_ARRAY_ITEMS) {
        return { ok: false, code: 'array-too-large' }
      }
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 })
      }
      continue
    }
    for (const entry of Object.values(current.value)) {
      pending.push({ value: entry, depth: current.depth + 1 })
    }
  }
  return null
}

function hasOversizedSemanticArray(changeSet: ChangeSet): boolean {
  for (const op of changeSet.ops) {
    switch (op.kind) {
      case 'merge_notes':
      case 'group_cards':
        if (Array.isArray(op.cardIds) && op.cardIds.length > MAX_CHANGE_SET_ARRAY_ITEMS) return true
        break
      case 'move_cards':
      case 'move_sections':
        if (Array.isArray(op.moves) && op.moves.length > MAX_CHANGE_SET_ARRAY_ITEMS) return true
        break
      case 'create_reference':
        if (Array.isArray(op.reference?.authors) &&
          op.reference.authors.length > MAX_CHANGE_SET_ARRAY_ITEMS) return true
        break
    }
  }
  return false
}

export function validateChangeSetBounds(changeSet: ChangeSet): { ok: true } | BoundsFailure {
  if (changeSet.ops.length > MAX_CHANGE_SET_OPS) {
    return { ok: false, code: 'too-many-ops' }
  }
  if (hasOversizedSemanticArray(changeSet)) {
    return { ok: false, code: 'array-too-large' }
  }
  const semantic = semanticChangeSet(changeSet)
  const structuralFailure = structuralBounds(semantic)
  if (structuralFailure) return structuralFailure
  if (Buffer.byteLength(JSON.stringify(semantic), 'utf8') > MAX_CHANGE_SET_SEMANTIC_BYTES) {
    return { ok: false, code: 'too-large' }
  }
  return { ok: true }
}
