import { useValue } from 'tldraw'
import { snapHighlight } from '../client/snapHighlight'
import './snap.css'

/**
 * The green field behind a live snap. Mounted as tldraw's `OnTheCanvas`
 * component, so it sits in page space and BEHIND the shapes — the two cards
 * being joined read as sitting on top of one shared surface rather than being
 * outlined separately.
 */
export function SnapHighlight() {
  const rect = useValue('snapHighlight', () => snapHighlight.get(), [])
  if (!rect) return null
  return (
    <div
      className="elves-snap-halo"
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.w,
        height: rect.h,
      }}
    />
  )
}
