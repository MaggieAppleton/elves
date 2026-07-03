import type { CanvasSnapshot } from './store'
import type { CardKind, SourceKind, Origin, Comment, Reference, RefType } from '../src/model/types'
import type { SectionAuthor } from '../src/model/sections'
import { SummarizableCard, cardGist } from '../src/model/summary'
import { resolveAssetPath } from './assets'

export interface CardDigest {
  id: string
  kind: CardKind
  sourceKind: SourceKind | null
  origin: Origin | null
  text: string
  x: number
  y: number
  comments: Comment[]
  mergedInto: string | null
  assetPath: string | null
  /** Structured metadata when this is a reference source card; null otherwise. */
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
  sourceKind: SourceKind | null
  x: number
  y: number
  gist: string
  textLen: number
  mergedInto?: string
  refType?: RefType
}

export interface CardMap {
  cards: CardMapEntry[]
  sections: SectionDigest[]
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

export function snapshotToCards(snapshot: CanvasSnapshot, assetsDir?: string): CardDigest[] {
  return cardShapes(snapshot).map((r: any) => ({
    id: r.id,
    kind: r.props.kind,
    sourceKind: r.props.sourceKind ?? null,
    origin: r.props.origin ?? null,
    text: r.props.text ?? '',
    x: r.x,
    y: r.y,
    comments: r.props.comments ?? [],
    mergedInto: r.props.mergedInto ?? null,
    assetPath:
      assetsDir && r.props.sourceKind === 'image' && r.props.assetId
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
    sourceKind: r.props.sourceKind ?? null,
    text: r.props.text ?? '',
    summary: r.props.summary ?? null,
    summaryOfHash: r.props.summaryOfHash ?? null,
  }))
}

/** The cheap navigation map — sections plus a small entry per card, no full text. */
export function snapshotToCardMap(snapshot: CanvasSnapshot): CardMap {
  const cards = cardShapes(snapshot).map((r: any): CardMapEntry => {
    const entry: CardMapEntry = {
      id: r.id,
      kind: r.props.kind,
      sourceKind: r.props.sourceKind ?? null,
      x: r.x,
      y: r.y,
      gist: cardGist({
        kind: r.props.kind,
        sourceKind: r.props.sourceKind ?? null,
        text: r.props.text ?? '',
        summary: r.props.summary ?? null,
        summaryOfHash: r.props.summaryOfHash ?? null,
      }),
      textLen: (r.props.text ?? '').length,
    }
    if (r.props.mergedInto) entry.mergedInto = r.props.mergedInto
    if (r.props.reference?.refType) entry.refType = r.props.reference.refType
    return entry
  })
  return { cards, sections: snapshotToSections(snapshot) }
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
      x: r.x,
      y: r.y,
      authoredBy: r.props.authoredBy ?? 'user',
    }))
}

export function snapshotToCanvasDigest(snapshot: CanvasSnapshot, assetsDir?: string): CanvasDigest {
  return { cards: snapshotToCards(snapshot, assetsDir), sections: snapshotToSections(snapshot) }
}
