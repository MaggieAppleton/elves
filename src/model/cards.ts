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
    kind: 'prose', sourceKind: null, origin: null, text,
    comments: [], mergedInto: null, assetId: null, reference: null, ...NO_SUMMARY,
  }
}

export function makeSourceCardProps(text = '', origin: Origin = 'typed'): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'source', sourceKind: 'text', origin, text,
    comments: [], mergedInto: null, assetId: null, reference: null, ...NO_SUMMARY,
  }
}

export function makeImageSourceCardProps(assetId: string): CardProps {
  return {
    w: 280, h: 200,
    kind: 'source', sourceKind: 'image', origin: 'image', text: '',
    comments: [], mergedInto: null, assetId, reference: null, ...NO_SUMMARY,
  }
}

/**
 * A reference source card: structured bibliographic metadata (from unfurl or
 * Claude) with an empty annotation `text` the user fills in later. It is a
 * SOURCE card — reference material, never prose — so the boundary holds.
 */
export function makeReferenceCardProps(reference: Reference): CardProps {
  return {
    w: REFERENCE_DEFAULT_W, h: REFERENCE_DEFAULT_H,
    kind: 'source', sourceKind: 'reference', origin: 'reference', text: '',
    comments: [], mergedInto: null, assetId: null, reference, ...NO_SUMMARY,
  }
}

export function isProseCard(p: { kind: CardKind }): boolean {
  return p.kind === 'prose'
}

export function isSourceCard(p: { kind: CardKind }): boolean {
  return p.kind === 'source'
}

/**
 * Elves' core rule, as testable code. Claude never edits the text of an
 * existing card — source or prose. (Claude *creating* new source cards is a
 * separate, dedicated capability added in Phase 2's tool layer; it is not
 * text-editing.) Phase 2's server tool API MUST consult this before applying
 * any text mutation attributed to Claude.
 */
export function claudeMayEditCardText(_kind: CardKind): boolean {
  return false
}
