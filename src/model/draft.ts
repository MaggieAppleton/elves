import type { CardKind, FigureStatus, NoteKind } from './types'
import type { SectionAuthor } from './sections'

/**
 * Compiling the canvas into a LINEAR DRAFT — the piece read as a piece.
 *
 * The canvas convention this honors, and the whole reason this can't be a plain
 * left-to-right scan of card x-positions:
 *   - SECTIONS run left → right as the order of the piece.
 *   - Within a section, CARDS run top → bottom as their order within it.
 *
 * So a card that sits further right but higher in a section comes BEFORE a card
 * further left but lower in the same section. Section order dominates; y orders
 * within a band. This module is pure (no store, no network) so the client pane,
 * the server `/draft` endpoint, and the `read_draft` MCP tool all compile the
 * exact same reading order from one place.
 */

/** A card as the compile needs to see it — page-space box plus the skip flags. */
export interface DraftCardInput {
  id: string
  kind: CardKind
  noteKind?: NoteKind | null
  /** Page-space top-left. */
  x: number
  y: number
  w: number
  h: number
  text: string
  assetId?: string | null
  figureTitle?: string
  figureStatus?: FigureStatus | null
  /** A merged-away card is hidden on the canvas and never compiles. */
  mergedInto: string | null
  /** The user opted this card out of the linear draft. */
  draftExcluded: boolean
  /**
   * Unresolved-comment count, surfaced as a marker in the pane. Optional and
   * carried straight through — the server/MCP compile leaves it unset (the
   * read-only draft carries counts, never comment bodies, in v1).
   */
  unresolvedComments?: number
}

/** A section as the compile needs it — its left edge is a band boundary. */
export interface DraftSectionInput {
  id: string
  /** Page-space left edge. */
  x: number
  text: string
  authoredBy: SectionAuthor
}

export interface DraftBlockCard {
  type: 'prose'
  id: string
  text: string
  /** Present only when passed on the input (pane path); omitted otherwise. */
  unresolvedComments?: number
}

export interface DraftBlockFigure {
  type: 'figure'
  id: string
  title: string
  description: string
  status: FigureStatus | null
}

export interface DraftBlockImage {
  type: 'image'
  id: string
  assetId: string
}

export type DraftItem = DraftBlockCard | DraftBlockFigure | DraftBlockImage

/** One heading + its paragraphs, in reading order. */
export interface DraftBlock {
  /** The section whose band this is, or null for the opening (pre-first-section) block. */
  sectionId: string | null
  /** The heading text, or null for the opening block. */
  section: string | null
  /** Heading author — drives the pane's agent-accent labels; null when opening. */
  authoredBy: SectionAuthor | null
  items: DraftItem[]
}

/** A card compiles into the draft only if it is readable draft material the user hasn't hidden. */
export function compilesToDraft(card: DraftCardInput): boolean {
  if (card.mergedInto || card.draftExcluded) return false
  if (card.kind === 'prose') return true
  if (card.kind === 'figure') return true
  return card.kind === 'note' && card.noteKind === 'image' && !!card.assetId
}

function centerX(c: DraftCardInput): number {
  return c.x + c.w / 2
}

// Reading order WITHIN a band: top → bottom by center-y, tiebroken left → right
// by center-x so side-by-side cards (columns) read the way they sit.
function byReadingOrder(a: DraftCardInput, b: DraftCardInput): number {
  const ay = a.y + a.h / 2
  const by = b.y + b.h / 2
  if (ay !== by) return ay - by
  return centerX(a) - centerX(b)
}

function toBlockCard(c: DraftCardInput): DraftBlockCard {
  return c.unresolvedComments === undefined
    ? { type: 'prose', id: c.id, text: c.text }
    : { type: 'prose', id: c.id, text: c.text, unresolvedComments: c.unresolvedComments }
}

function toDraftItem(c: DraftCardInput): DraftItem {
  if (c.kind === 'figure') {
    return {
      type: 'figure',
      id: c.id,
      title: c.figureTitle ?? '',
      description: c.text,
      status: c.figureStatus ?? null,
    }
  }
  if (c.kind === 'note' && c.noteKind === 'image' && c.assetId) {
    return { type: 'image', id: c.id, assetId: c.assetId }
  }
  return toBlockCard(c)
}

/**
 * Compile the canvas into ordered blocks. Sections are sorted by left edge; each
 * compilable card is assigned to the LAST section whose left edge ≤ the card's
 * center x (cards left of every section form an unlabeled opening block). Empty
 * bands are dropped so the draft has no headings without prose beneath them.
 */
export function compileDraft(
  cards: DraftCardInput[],
  sections: DraftSectionInput[],
): DraftBlock[] {
  const sorted = [...sections].sort((a, b) => a.x - b.x)
  const compilable = cards.filter(compilesToDraft)

  // Band index for a card: -1 = opening block, else an index into `sorted`.
  const bandOf = (c: DraftCardInput): number => {
    const cx = centerX(c)
    let idx = -1
    for (let i = 0; i < sorted.length; i++) {
      // `sorted` ascends by left edge, so once one exceeds cx, all later do too.
      if (sorted[i].x <= cx) idx = i
      else break
    }
    return idx
  }

  const buckets = new Map<number, DraftCardInput[]>()
  for (const c of compilable) {
    const b = bandOf(c)
    const bucket = buckets.get(b)
    if (bucket) bucket.push(c)
    else buckets.set(b, [c])
  }

  const blocks: DraftBlock[] = []
  const opening = buckets.get(-1)
  if (opening && opening.length) {
    blocks.push({
      sectionId: null,
      section: null,
      authoredBy: null,
      items: opening.sort(byReadingOrder).map(toDraftItem),
    })
  }
  sorted.forEach((s, i) => {
    const inBand = buckets.get(i)
    if (!inBand || !inBand.length) return // drop empty sections
    blocks.push({
      sectionId: s.id,
      section: s.text,
      authoredBy: s.authoredBy,
      items: inBand.sort(byReadingOrder).map(toDraftItem),
    })
  })
  return blocks
}

/** The `read_draft` MCP / server shape: heading text + typed draft items. */
export interface ReadDraftBlock {
  section: string | null
  items: Array<
    | { type: 'prose'; id: string; text: string }
    | { type: 'figure'; id: string; title: string; description: string; status: FigureStatus | null }
    | { type: 'image'; id: string; assetId: string }
  >
}

/** Project rich blocks down to the read-only tool contract (no comment counts). */
export function toReadDraftBlocks(blocks: DraftBlock[]): ReadDraftBlock[] {
  return blocks.map((b) => ({
    section: b.section,
    items: b.items.map((item) => {
      if (item.type === 'prose') return { type: 'prose', id: item.id, text: item.text }
      if (item.type === 'figure') {
        return {
          type: 'figure',
          id: item.id,
          title: item.title,
          description: item.description,
          status: item.status,
        }
      }
      return { type: 'image', id: item.id, assetId: item.assetId }
    }),
  }))
}

/**
 * Copy-as-Markdown: `##` headings and blank-line-separated paragraphs, in
 * narrative order. The opening block has no heading. Cards with empty text are
 * dropped (a blank paragraph is noise, not a paragraph); a section left with no
 * non-empty paragraph is dropped too.
 */
export function draftToMarkdown(blocks: DraftBlock[]): string {
  const chunks: string[] = []
  for (const block of blocks) {
    const parts: string[] = []
    for (const item of block.items) {
      if (item.type === 'prose') {
        const text = item.text.trim()
        if (text) parts.push(text)
      } else if (item.type === 'figure') {
        const figureParts = [`[Figure: ${item.title.trim() || 'Untitled figure'}]`]
        if (item.status) figureParts.push(`Status: ${item.status}`)
        const description = item.description.trim()
        if (description) figureParts.push(description)
        parts.push(figureParts.join('\n\n'))
      } else {
        parts.push(`![Image](${item.assetId})`)
      }
    }
    // A heading with no prose beneath it is noise in an exported draft — drop the
    // whole block (opening or labeled) once it has no non-empty paragraphs.
    if (parts.length === 0) continue
    const blockParts: string[] = []
    if (block.section !== null && block.section.trim().length > 0) {
      blockParts.push(`## ${block.section.trim()}`)
    }
    blockParts.push(...parts)
    if (blockParts.length) chunks.push(blockParts.join('\n\n'))
  }
  return chunks.join('\n\n')
}
