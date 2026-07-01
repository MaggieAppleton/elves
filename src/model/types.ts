export type CardKind = 'source' | 'prose'
export type SourceKind = 'text' | 'image'
export type Origin = 'tana' | 'image' | 'typed'

export type CommentType = 'needs-evidence' | 'weak-argument' | 'needs-citation'

export interface Comment {
  id: string
  /** null = freeform comment. */
  type: CommentType | null
  text: string
  resolved: boolean
  author: 'claude'
}

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
  /** Claude-authored comments attached to this card. */
  comments: Comment[]
  /** If set, this source card was merged into the referenced representative card (hidden, recoverable). */
  mergedInto: string | null
}

export const CARD_DEFAULT_W = 240
export const CARD_DEFAULT_H = 120
