export type CardKind = 'note' | 'prose'
export type NoteKind = 'text' | 'image' | 'reference'
export type Origin = 'tana' | 'image' | 'typed' | 'transcribed' | 'reference'

export type CommentType = 'needs-evidence' | 'weak-argument' | 'needs-citation'

/** The kind of external thing a reference points at — drives its card face. */
export type RefType =
  | 'paper' | 'article' | 'book' | 'software'
  | 'social' | 'video' | 'wiki' | 'link'

/** Who resolved a reference's metadata, in precedence order user > claude > unfurl. */
export type RefFetcher = 'unfurl' | 'claude' | 'user'

/**
 * Structured metadata for a reference note card (noteKind === 'reference').
 * These are bibliographic *facts* — the app (unfurl) or Claude (research) may
 * write them. They are distinct from the card's `text`, which stays the user's
 * own annotation about the source. Favicon/thumbnail are stored as local asset
 * files (ids only here), so a project stays a portable, offline folder.
 */
export interface Reference {
  url: string
  refType: RefType
  title: string | null
  /** Authors (papers/books), or ["@handle"] for social, or a blog author. */
  authors: string[]
  siteName: string | null
  year: number | null
  /** "CHI 2025", a journal, or a publisher. */
  venue: string | null
  /** OG description, an abstract snippet, or a post's text. */
  description: string | null
  faviconAssetId: string | null
  thumbnailAssetId: string | null
  doi: string | null
  arxivId: string | null
  fetchedBy: RefFetcher | null
  /** ISO timestamp of when the metadata was last resolved. */
  fetchedAt: string | null
}

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
  /** Set when kind === 'note'; null for prose. */
  noteKind: NoteKind | null
  /** Provenance for note cards; null for prose. */
  origin: Origin | null
  /** Human-authored. For note cards this is reference text, never prose. */
  text: string
  /** Claude-authored comments attached to this card. */
  comments: Comment[]
  /** If set, this note card was merged into the referenced representative card (hidden, recoverable). */
  mergedInto: string | null
  /** For image note cards: the stored asset id (a filename under data/assets/). null otherwise. */
  assetId: string | null
  /** For reference note cards (noteKind === 'reference'): structured metadata; null otherwise. */
  reference: Reference | null
  /**
   * A model-authored one-phrase gist of a long card's `text`, shown on the
   * navigation map and when the canvas is zoomed out. It is a LABEL about the
   * card — like a comment or a section header — never the card's own words, so
   * it lives here beside `text` and never replaces it. null when the card is
   * short (it is its own summary) or no summary has been generated yet.
   */
  summary: string | null
  /** Hash of the `text` this summary was built from, for staleness detection. */
  summaryOfHash: string | null
  /** Provenance of the summary, e.g. 'ollama/llama3.2' or 'openai/gpt-4o-mini'. */
  summaryBy: string | null
  /** ISO timestamp of when the summary was generated. */
  summaryAt: string | null
}

export const CARD_DEFAULT_W = 240
export const CARD_DEFAULT_H = 120

// Reference cards are a touch wider than notes to hold a title + a metadata row
// comfortably; height is measured to fit the type-adaptive face.
export const REFERENCE_DEFAULT_W = 260
export const REFERENCE_DEFAULT_H = 116
