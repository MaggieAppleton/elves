import type { CanvasSnapshot } from './store'
import type { CardKind, SourceKind, Origin, Comment } from '../src/model/types'
import type { SectionAuthor } from '../src/model/sections'
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

function storeOf(snapshot: CanvasSnapshot): Record<string, any> {
  const doc = (snapshot?.document ?? null) as { store?: Record<string, any>; records?: Record<string, any> } | null
  if (!doc) return {}
  return doc.store ?? doc.records ?? {}
}

export function snapshotToCards(snapshot: CanvasSnapshot, assetsDir?: string): CardDigest[] {
  const store = storeOf(snapshot)
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'card' && r.props)
    .map((r: any) => ({
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
    }))
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
