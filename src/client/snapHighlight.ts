import { atom } from 'tldraw'
import type { LayoutRect } from '../model/layout'

/**
 * The page-space box drawn behind a live snap — it contains both the card being
 * dragged and the card it has snapped onto, so the pairing is visible before
 * you let go. Null whenever no snap is engaged, which is also how "you have
 * dragged far enough to leave the stack" reads: the field simply goes away.
 *
 * A signal rather than React state because it is written from `onTranslate`,
 * which runs outside React on every frame of a drag.
 */
export const snapHighlight = atom<LayoutRect | null>('snapHighlight', null)

export function clearSnapHighlight(): void {
  if (snapHighlight.get() !== null) snapHighlight.set(null)
}
