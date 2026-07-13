export type CardKind = 'note' | 'prose' | 'figure'
export type NoteKind = 'text' | 'image' | 'reference'
export type Origin = 'tana' | 'image' | 'typed' | 'transcribed' | 'reference'

/**
 * A figure card's lifecycle, cycled by clicking its status chip. A planned
 * visual moves `idea → sketched → final` as it firms up. See src/model/figures.ts
 * for the cycle order and the FIGURE_STATUSES runtime list this type mirrors.
 */
export type FigureStatus = 'idea' | 'sketched' | 'final'

export type CommentType =
  | 'needs-evidence'
  | 'weak-argument'
  | 'needs-citation'
  | 'wants-figure'
  | 'counterpoint'
  | 'tighten'
  | 'unclear'
  | 'structure'

// Re-exported so CardProps' attribution field and the model layer share one type.
export type { Attribution, AttributionRun } from './attribution'
import type { Attribution } from './attribution'

/** The kind of external thing a reference points at — drives its card face. */
export type RefType =
  | 'paper' | 'article' | 'book' | 'software'
  | 'social' | 'video' | 'wiki' | 'link'

/** Who resolved a reference's metadata, in precedence order user > claude > unfurl. */
export type RefFetcher = 'unfurl' | 'claude' | 'user'

/**
 * Structured metadata for a reference note card (noteKind === 'reference').
 * These are bibliographic *facts* — the app (unfurl) or an agent (research) may
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
  /**
   * The agent that wrote the comment, as an agent id (e.g. 'claude'). An open
   * string, not a literal, so any agent's MCP server (see ELVES_AGENT) stamps its
   * own id — the id resolves through the agent registry to the comment's accent
   * and authorship mark.
   */
  author: string
  /**
   * The review pass this comment belongs to (a Review id, see
   * src/model/reviews.ts), or null for a comment made outside any pass. Groups a
   * pass's notes so the review panel can report "N notes, M open" per pass.
   */
  reviewId: string | null
  /**
   * A model-authored one-phrase gist of a long comment, shown zoomed out in
   * place of the full text (see commentGist in model/summary). Mirrors a
   * card's `summary` field exactly — same staleness/provenance shape, just
   * scoped to one comment instead of a whole card. null when not yet generated.
   */
  summary: string | null
  /** Hash of the `text` this summary was built from, for staleness detection. */
  summaryOfHash: string | null
  /** Provenance of the summary, e.g. 'ollama/llama3.2'. */
  summaryBy: string | null
  /** ISO timestamp of when the summary was generated. */
  summaryAt: string | null
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
  /**
   * The agent that authored this card via the MCP, as an agent id (e.g.
   * 'claude'); null = human-authored. Deliberately an open string, not an enum,
   * so a new agent needs no schema change — the agent registry (src/shapes/agents)
   * maps a known id to its display metadata, and an unknown id renders no mark.
   */
  authoredBy: string | null
  /**
   * Per-character authorship of `text`: a list of runs (author + length) that
   * concatenate to cover the text exactly (sum(length) === text.length). `author`
   * is the sentinel `'user'` (human) or an agent id. Where `authoredBy` records
   * only the LAST writer, this records EVERY contributor and the span each wrote,
   * so a card can show all its authors (and, in a later view layer, highlight one
   * author's spans). null on legacy cards not yet migrated; the engine
   * (src/model/attribution) treats null as one `'user'` run. See reattribute.
   */
  attribution: Attribution | null
  /** Agent-authored comments attached to this card. */
  comments: Comment[]
  /** Visible comment-stack height below the card body, including its top gutter. */
  commentH: number
  /** If set, this note card was merged into the referenced representative card (hidden, recoverable). */
  mergedInto: string | null
  /**
   * Keep this card out of the linear draft compile (the reading pane and
   * `read_draft`). Default false. The canvas is still the one place prose is
   * written; this only says "this aside isn't part of the piece as read
   * top-to-bottom". Excluded cards show a subtle marker on the canvas so it's
   * visible why they don't compile. See src/model/draft.ts.
   */
  draftExcluded: boolean
  /** For image note cards: the stored asset id (a filename under data/assets/). null otherwise. */
  assetId: string | null
  /** For reference note cards (noteKind === 'reference'): structured metadata; null otherwise. */
  reference: Reference | null
  /**
   * A figure card's short working title — the name of the planned visual. Its
   * `text` holds the description (what the visual needs to show), so the title is
   * a separate field, like a heading above the body. Empty '' for non-figure
   * cards. Like a section label, a figure's title + description are a *plan/
   * annotation*, never the user's prose — so an agent may author them (see
   * changeSetWritesText's create_figure_card exception).
   */
  figureTitle: string
  /**
   * A figure card's lifecycle status (idea → sketched → final), cycled by
   * clicking its status chip. null for non-figure cards.
   */
  figureStatus: FigureStatus | null
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
  /** Provenance of the summary, e.g. 'ollama/llama3.2'. */
  summaryBy: string | null
  /** ISO timestamp of when the summary was generated. */
  summaryAt: string | null
}

export const CARD_DEFAULT_W = 370
export const CARD_DEFAULT_H = 120

// Cards an agent adds through the MCP (any card whose `authoredBy` is stamped,
// i.e. every agent-written note and figure) are born at a comfortable measure.
// An agent drops in a finished thought — a suggestion, a planned figure — that
// reads better at a settled width without the user having to size it by hand
// every time. Height still follows the text (measured client-side), so this only
// sets how wide an agent's cards arrive.
export const AGENT_CARD_DEFAULT_W = 370

// Reference cards are a touch wider than notes to hold a title + a metadata row
// comfortably; height is measured to fit the type-adaptive face.
export const REFERENCE_DEFAULT_W = 260
export const REFERENCE_DEFAULT_H = 116

// Figure cards hold a prominent title over a smaller description inside a dashed
// sketch-frame; a touch wider than a note, and taller by default so the empty
// frame reads as "a visual goes here" before anything is written. Height is
// measured to fit the title + description (see measuredFigureHeight).
export const FIGURE_DEFAULT_W = 260
export const FIGURE_DEFAULT_H = 148
