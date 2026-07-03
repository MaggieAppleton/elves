import type { CanvasSnapshot } from './store'
import type { CardKind, NoteKind, Origin, Comment, Reference, RefType } from '../src/model/types'
import type { SectionAuthor } from '../src/model/sections'
import { SummarizableCard, cardGist } from '../src/model/summary'
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
 * A group on the MAP — a mechanical "these cards travel together" binding
 * (a tldraw group). `cardIds` are its direct card members; `bounds` is the
 * union of their resolved page bounds so Claude can see where the bundle sits.
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
  gist: string
  textLen: number
  mergedInto?: string
  refType?: RefType
  /** Set when this card is bound into a group (see CardMap.groups); omitted otherwise. */
  groupId?: string
}

export interface CardMap {
  cards: CardMapEntry[]
  sections: SectionDigest[]
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
      gist: cardGist({
        kind: r.props.kind,
        noteKind: r.props.noteKind ?? null,
        text: r.props.text ?? '',
        summary: r.props.summary ?? null,
        summaryOfHash: r.props.summaryOfHash ?? null,
      }),
      textLen: (r.props.text ?? '').length,
    }
    if (r.props.mergedInto) entry.mergedInto = r.props.mergedInto
    if (r.props.reference?.refType) entry.refType = r.props.reference.refType
    const groupId = directGroupId(store, r)
    if (groupId) entry.groupId = groupId
    return entry
  })
  return { cards, sections: snapshotToSections(snapshot), groups: snapshotToGroups(snapshot) }
}

/**
 * One entry per tldraw group shape: its direct card members, count, and the
 * union of their resolved page bounds. Groups with no card members are dropped
 * (nothing for Claude to act on).
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

export function snapshotToCanvasDigest(snapshot: CanvasSnapshot, assetsDir?: string): CanvasDigest {
  return { cards: snapshotToCards(snapshot, assetsDir), sections: snapshotToSections(snapshot) }
}
