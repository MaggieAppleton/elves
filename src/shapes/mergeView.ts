import { atom, type TLShape } from 'tldraw'
import type { CardShape } from './CardShapeUtil'

/**
 * Which merge-representative cards are currently "fanned out" so their merged
 * members can be read. This is a temporary PEEK — ephemeral session state, like
 * selection: never written to the canvas, reset on reload. It lives in a tldraw
 * `atom` (not React state or shape props) so a card component that reads it
 * re-renders reactively when the set changes, and so it survives the component
 * remounts tldraw does while panning/zooming.
 */
const expandedMerges = atom<ReadonlySet<string>>('expandedMerges', new Set())

export function isExpanded(representativeId: string): boolean {
  return expandedMerges.get().has(representativeId)
}

export function toggleExpanded(representativeId: string): void {
  const next = new Set(expandedMerges.get())
  if (next.has(representativeId)) next.delete(representativeId)
  else next.add(representativeId)
  expandedMerges.set(next)
}

/** Dismiss every open peek (e.g. on an empty-canvas click). No-op when none. */
export function collapseAll(): void {
  if (expandedMerges.get().size > 0) expandedMerges.set(new Set())
}

/**
 * True for a source card that was merged away into a representative. Such cards
 * are kept for recovery but must not render as their own shape — otherwise they
 * are invisible-yet-selectable "ghosts" on the canvas. `App` feeds this to
 * tldraw's `getShapeVisibility` so they are hidden from rendering AND hit-testing;
 * the representative draws them instead (as a stack / fan-out).
 */
export function cardIsHidden(shape: TLShape): boolean {
  return shape.type === 'card' && !!(shape as CardShape).props.mergedInto
}

/** The cards that were merged into `representativeId`, in page order. */
export function mergedMembers(shapes: TLShape[], representativeId: string): CardShape[] {
  return shapes.filter(
    (s): s is CardShape => s.type === 'card' && (s as CardShape).props.mergedInto === representativeId,
  )
}
