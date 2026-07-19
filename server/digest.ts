import type { CanvasSnapshot } from './store'
import type { CardKind, NoteKind, Origin, Comment, Reference, RefType, FigureStatus } from '../src/model/types'
import type { SectionAuthor } from '../src/model/sections'
import { SummarizableCard, SummarizableComment, cardGist } from '../src/model/summary'
import {
  compileDraft, toReadDraftBlocks, type DraftCardInput, type DraftSectionInput, type ReadDraftBlock,
} from '../src/model/draft'
import { resolveAssetPath } from './assets'

export interface CardDigest {
  id: string
  kind: CardKind
  noteKind: NoteKind | null
  origin: Origin | null
  text: string
  x: number
  y: number
  comments: Comment[]
  mergedInto: string | null
  assetPath: string | null
  /** Structured metadata when this is a reference note card; null otherwise. */
  reference: Reference | null
  /** A figure card's working title; '' for non-figure cards. Its `text` holds the description. */
  figureTitle: string
  /** A figure card's status (idea|sketched|final); null for non-figure cards. */
  figureStatus: FigureStatus | null
  /** Model-authored gist of a long card; null when short or not yet generated. */
  summary: string | null
}

export interface SectionDigest {
  id: string
  text: string
  x: number
  y: number
  authoredBy: SectionAuthor
}

/**
 * A question card on the map: an agent-authored question floating near a cluster.
 * `dismissed` is included so the agent sees its own answered/waved-off questions and
 * won't re-ask them — a dismissed question is an answered "no".
 */
export interface QuestionDigest {
  id: string
  text: string
  x: number
  y: number
  authoredBy: string
  dismissed: boolean
}

/**
 * A group on the MAP — a mechanical "these cards travel together" binding
 * (a tldraw group). `cardIds` are its direct card members; `bounds` is the
 * union of their resolved page bounds so the agent can see where the bundle sits.
 */
export interface GroupDigest {
  id: string
  cardIds: string[]
  memberCount: number
  bounds: { x: number; y: number; w: number; h: number }
}

export interface CanvasDigest {
  cards: CardDigest[]
  sections: SectionDigest[]
  questions: QuestionDigest[]
}

/**
 * A card as it appears on the navigation MAP: enough to decide where to act and
 * whether to drill in, but NOT the full text, comment bodies, or reference blob.
 * `gist` is the model summary when present, else a mechanical truncation — so
 * the map is always readable and always small. Null-ish fields are omitted to
 * keep each entry tiny.
 */
export interface CardMapEntry {
  id: string
  kind: CardKind
  noteKind: NoteKind | null
  x: number
  y: number
  /** Card size on the page. Height is measured to fit the text, so it's the
   * real footprint — use x/y/w/h to place new cards in clear space, not on top. */
  w: number
  h: number
  gist: string
  textLen: number
  mergedInto?: string
  refType?: RefType
  /** A figure card's status (idea|sketched|final); set only for figures, so a
   * critique pass can see planned visuals and nudge long-standing `idea`s. */
  figureStatus?: FigureStatus
  /** Set when this card is bound into a group (see CardMap.groups); omitted otherwise. */
  groupId?: string
}

export interface CardMap {
  cards: CardMapEntry[]
  sections: SectionDigest[]
  questions: QuestionDigest[]
  groups: GroupDigest[]
}

function storeOf(snapshot: CanvasSnapshot): Record<string, any> {
  const doc = (snapshot?.document ?? null) as { store?: Record<string, any>; records?: Record<string, any> } | null
  if (!doc) return {}
  return doc.store ?? doc.records ?? {}
}

function cardShapes(snapshot: CanvasSnapshot): any[] {
  return Object.values(storeOf(snapshot)).filter(
    (r: any) => r && r.typeName === 'shape' && r.type === 'card' && r.props,
  )
}

function groupShapes(snapshot: CanvasSnapshot): any[] {
  return Object.values(storeOf(snapshot)).filter(
    (r: any) => r && r.typeName === 'shape' && r.type === 'group',
  )
}

/**
 * Resolve a shape's PAGE position from the raw store JSON. In tldraw a shape's
 * x/y are in its parent's space; a top-level shape's parent is the page (so
 * x/y are already page coords), but a grouped shape's parent is a `group` shape,
 * making its x/y group-local. We sum x/y up the parentId chain to the page.
 *
 * This additive walk is exact only when no ancestor is rotated — which holds for
 * this app: cards are axis-aligned and we never rotate a group. Depth-guarded so
 * a malformed cyclic parentId can't spin forever.
 */
export function resolvePageXY(store: Record<string, any>, shape: any): { x: number; y: number } {
  let x = shape.x ?? 0
  let y = shape.y ?? 0
  let parentId = shape.parentId
  for (let depth = 0; depth < 32; depth++) {
    const parent = parentId ? store[parentId] : undefined
    if (!parent || parent.typeName !== 'shape') break // reached the page (or a dangling ref)
    x += parent.x ?? 0
    y += parent.y ?? 0
    parentId = parent.parentId
  }
  return { x, y }
}

/** The direct group parent of a shape, if it sits inside a `group`; else null. */
function directGroupId(store: Record<string, any>, shape: any): string | null {
  const parent = shape.parentId ? store[shape.parentId] : undefined
  return parent && parent.typeName === 'shape' && parent.type === 'group' ? parent.id : null
}

export function snapshotToCards(snapshot: CanvasSnapshot, assetsDir?: string): CardDigest[] {
  const store = storeOf(snapshot)
  return cardShapes(snapshot).map((r: any) => ({
    id: r.id,
    kind: r.props.kind,
    noteKind: r.props.noteKind ?? null,
    origin: r.props.origin ?? null,
    text: r.props.text ?? '',
    ...resolvePageXY(store, r),
    comments: r.props.comments ?? [],
    mergedInto: r.props.mergedInto ?? null,
    assetPath:
      assetsDir && r.props.noteKind === 'image' && r.props.assetId
        ? resolveAssetPath(assetsDir, r.props.assetId)
        : null,
    reference: r.props.reference ?? null,
    figureTitle: r.props.figureTitle ?? '',
    figureStatus: r.props.figureStatus ?? null,
    summary: r.props.summary ?? null,
  }))
}

/** Just the fields summary reconciliation reasons about, keyed by card id. */
export function snapshotToSummarizableCards(
  snapshot: CanvasSnapshot,
): Array<SummarizableCard & { id: string }> {
  return cardShapes(snapshot).map((r: any) => ({
    id: r.id,
    kind: r.props.kind,
    noteKind: r.props.noteKind ?? null,
    text: r.props.text ?? '',
    summary: r.props.summary ?? null,
    summaryOfHash: r.props.summaryOfHash ?? null,
  }))
}

/** Just the fields comment summary reconciliation reasons about, one entry per
 * comment across every card, keyed by both its card and its own comment id. */
export function snapshotToSummarizableComments(
  snapshot: CanvasSnapshot,
): Array<SummarizableComment & { cardId: string; commentId: string }> {
  const out: Array<SummarizableComment & { cardId: string; commentId: string }> = []
  for (const r of cardShapes(snapshot)) {
    const comments = (r.props.comments ?? []) as Comment[]
    for (const c of comments) {
      out.push({
        cardId: r.id,
        commentId: c.id,
        text: c.text ?? '',
        summary: c.summary ?? null,
        summaryOfHash: c.summaryOfHash ?? null,
      })
    }
  }
  return out
}

/** Just the fields question-summary reconciliation reasons about, keyed by the
 * question's own shape id. A question is agent-authored plain text, so it is
 * summarizable exactly like a comment. */
export function snapshotToSummarizableQuestions(
  snapshot: CanvasSnapshot,
): Array<SummarizableComment & { questionId: string }> {
  const store = storeOf(snapshot)
  return Object.values(store)
    // A dismissed question is hidden and its gist never shows, so it should
    // never trigger an Ollama call or count toward pending work.
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'question' && r.props && !r.props.dismissed)
    .map((r: any) => ({
      questionId: r.id,
      text: r.props.text ?? '',
      summary: r.props.summary ?? null,
      summaryOfHash: r.props.summaryOfHash ?? null,
    }))
}

/** The cheap navigation map — sections/groups plus a small entry per card, no full text. */
export function snapshotToCardMap(snapshot: CanvasSnapshot): CardMap {
  const store = storeOf(snapshot)
  const cards = cardShapes(snapshot).map((r: any): CardMapEntry => {
    const { x, y } = resolvePageXY(store, r)
    const entry: CardMapEntry = {
      id: r.id,
      kind: r.props.kind,
      noteKind: r.props.noteKind ?? null,
      x,
      y,
      w: r.props.w ?? 0,
      h: r.props.h ?? 0,
      gist: cardGist({
        kind: r.props.kind,
        noteKind: r.props.noteKind ?? null,
        text: r.props.text ?? '',
        summary: r.props.summary ?? null,
        summaryOfHash: r.props.summaryOfHash ?? null,
        figureTitle: r.props.figureTitle ?? '',
      }),
      textLen: (r.props.text ?? '').length,
    }
    if (r.props.mergedInto) entry.mergedInto = r.props.mergedInto
    if (r.props.reference?.refType) entry.refType = r.props.reference.refType
    if (r.props.kind === 'figure' && r.props.figureStatus) entry.figureStatus = r.props.figureStatus
    const groupId = directGroupId(store, r)
    if (groupId) entry.groupId = groupId
    return entry
  })
  return {
    cards,
    sections: snapshotToSections(snapshot),
    questions: snapshotToQuestions(snapshot),
    groups: snapshotToGroups(snapshot),
  }
}

/**
 * One entry per tldraw group shape: its direct card members, count, and the
 * union of their resolved page bounds. Groups with no card members are dropped
 * (nothing for the agent to act on).
 */
export function snapshotToGroups(snapshot: CanvasSnapshot): GroupDigest[] {
  const store = storeOf(snapshot)
  const cards = cardShapes(snapshot)
  return groupShapes(snapshot)
    .map((g: any): GroupDigest | null => {
      const members = cards.filter((c: any) => c.parentId === g.id)
      if (members.length === 0) return null
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const c of members) {
        const { x, y } = resolvePageXY(store, c)
        const w = c.props?.w ?? 0
        const h = c.props?.h ?? 0
        minX = Math.min(minX, x); minY = Math.min(minY, y)
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h)
      }
      return {
        id: g.id,
        cardIds: members.map((c: any) => c.id),
        memberCount: members.length,
        bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      }
    })
    .filter((g): g is GroupDigest => g !== null)
}

/**
 * Every group shape id present in the project, regardless of whether it still
 * has card members — used only to check a referenced groupId actually lives
 * here (snapshotToGroups drops empty groups, which would wrongly read as
 * "not in project" for that check).
 */
export function snapshotToGroupIds(snapshot: CanvasSnapshot): string[] {
  return groupShapes(snapshot).map((g: any) => g.id)
}

/** Full digests for a specific set of card ids — the drill-down after the map. */
export function snapshotToCardsById(
  snapshot: CanvasSnapshot,
  ids: string[],
  assetsDir?: string,
): CardDigest[] {
  const want = new Set(ids)
  return snapshotToCards(snapshot, assetsDir).filter((c) => want.has(c.id))
}

export function snapshotToSections(snapshot: CanvasSnapshot): SectionDigest[] {
  const store = storeOf(snapshot)
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'section' && r.props)
    .map((r: any) => ({
      id: r.id,
      text: r.props.text ?? '',
      ...resolvePageXY(store, r),
      authoredBy: r.props.authoredBy ?? 'user',
    }))
}

export function snapshotToQuestions(snapshot: CanvasSnapshot): QuestionDigest[] {
  const store = storeOf(snapshot)
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'question' && r.props)
    .map((r: any) => ({
      id: r.id,
      text: r.props.text ?? '',
      ...resolvePageXY(store, r),
      authoredBy: r.props.authoredBy ?? 'claude',
      dismissed: r.props.dismissed ?? false,
    }))
}

export function snapshotToCanvasDigest(snapshot: CanvasSnapshot, assetsDir?: string): CanvasDigest {
  return {
    cards: snapshotToCards(snapshot, assetsDir),
    sections: snapshotToSections(snapshot),
    questions: snapshotToQuestions(snapshot),
  }
}

/**
 * Compile the canvas into the LINEAR DRAFT — ordered blocks of typed draft
 * items, reusing the same pure `compileDraft` the client pane uses so
 * `read_draft` and the pane can never disagree about reading order. This is
 * what surfaces the top-to-bottom-within-sections convention to the agent, which
 * the position-only map can't. Read-only: no prose-boundary implications.
 */
export function snapshotToDraft(snapshot: CanvasSnapshot): ReadDraftBlock[] {
  const store = storeOf(snapshot)
  const cards: DraftCardInput[] = cardShapes(snapshot).map((r: any) => ({
    id: r.id,
    kind: r.props.kind,
    noteKind: r.props.noteKind ?? null,
    ...resolvePageXY(store, r),
    w: r.props.w ?? 0,
    h: r.props.h ?? 0,
    text: r.props.text ?? '',
    assetId: r.props.assetId ?? null,
    figureTitle: r.props.figureTitle ?? '',
    figureStatus: r.props.figureStatus ?? null,
    mergedInto: r.props.mergedInto ?? null,
    draftExcluded: r.props.draftExcluded ?? false,
  }))
  const sections: DraftSectionInput[] = snapshotToSections(snapshot).map((s) => ({
    id: s.id,
    x: s.x,
    text: s.text,
    authoredBy: s.authoredBy,
  }))
  return toReadDraftBlocks(compileDraft(cards, sections))
}
