import {
  CardKind, CardProps, Origin, Reference, CARD_DEFAULT_W, CARD_DEFAULT_H,
  REFERENCE_DEFAULT_W, REFERENCE_DEFAULT_H,
} from './types'

export { CARD_DEFAULT_W, CARD_DEFAULT_H }

// A summary is generated later (server-side, for long cards); a card is born
// without one. Keeping the four fields together keeps every factory honest.
const NO_SUMMARY = { summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null }

export function makeProseCardProps(text = ''): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'prose', noteKind: null, origin: null, text,
    comments: [], mergedInto: null, assetId: null, reference: null, ...NO_SUMMARY,
  }
}

export function makeNoteCardProps(text = '', origin: Origin = 'typed'): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'note', noteKind: 'text', origin, text,
    comments: [], mergedInto: null, assetId: null, reference: null, ...NO_SUMMARY,
  }
}

export function makeImageNoteCardProps(assetId: string): CardProps {
  return {
    w: 280, h: 200,
    kind: 'note', noteKind: 'image', origin: 'image', text: '',
    comments: [], mergedInto: null, assetId, reference: null, ...NO_SUMMARY,
  }
}

/**
 * A reference note card: structured bibliographic metadata (from unfurl or
 * Claude) with an empty annotation `text` the user fills in later. It is a
 * note card — reference material, never prose — so the boundary holds.
 */
export function makeReferenceCardProps(reference: Reference): CardProps {
  return {
    w: REFERENCE_DEFAULT_W, h: REFERENCE_DEFAULT_H,
    kind: 'note', noteKind: 'reference', origin: 'reference', text: '',
    comments: [], mergedInto: null, assetId: null, reference, ...NO_SUMMARY,
  }
}

export function isProseCard(p: { kind: CardKind }): boolean {
  return p.kind === 'prose'
}

export function isNoteCard(p: { kind: CardKind }): boolean {
  return p.kind === 'note'
}

/**
 * Elves' core rule, as testable code. Claude never edits the text of an
 * existing card — note or prose. (Claude *creating* new note cards is a
 * separate, dedicated capability added in Phase 2's tool layer; it is not
 * text-editing.) Phase 2's server tool API MUST consult this before applying
 * any text mutation attributed to Claude.
 */
export function claudeMayEditCardText(_kind: CardKind): boolean {
  return false
}
