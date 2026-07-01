import type { CanvasSnapshot } from './store'
import type { CardKind, SourceKind, Origin, Comment } from '../src/model/types'

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
}

export function snapshotToCards(snapshot: CanvasSnapshot): CardDigest[] {
  const doc = (snapshot?.document ?? null) as { store?: Record<string, any>; records?: Record<string, any> } | null
  if (!doc) return []
  const store = doc.store ?? doc.records ?? {}
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
    }))
}
