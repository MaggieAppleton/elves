import {
  CardKind, CardProps, Origin, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from './types'

export { CARD_DEFAULT_W, CARD_DEFAULT_H }

export function makeProseCardProps(text = ''): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'prose', sourceKind: null, origin: null, text,
    comments: [], mergedInto: null,
  }
}

export function makeSourceCardProps(text = '', origin: Origin = 'typed'): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'source', sourceKind: 'text', origin, text,
    comments: [], mergedInto: null,
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
