export type CardKind = 'source' | 'prose'
export type SourceKind = 'text' | 'image'
export type Origin = 'tana' | 'image' | 'typed'

export interface CardProps {
  w: number
  h: number
  kind: CardKind
  /** Set when kind === 'source'; null for prose. */
  sourceKind: SourceKind | null
  /** Provenance for source cards; null for prose. */
  origin: Origin | null
  /** Human-authored. For source cards this is reference text, never prose. */
  text: string
}

export const CARD_DEFAULT_W = 240
export const CARD_DEFAULT_H = 120
