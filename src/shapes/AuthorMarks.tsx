import type { Attribution } from '../model/types'
import { contributors } from '../model/attribution'
import { authorInfo } from './agents'

/**
 * The stacked authorship marks for a card: every contributor to its text, not
 * just the last writer. Each contributor renders as a small logomark tinted its
 * accent — the human ('user') and any agents — overlapping slightly so several
 * authors read as one compact cluster. Reuses the single-mark `.elves-agent-mark`
 * markup/styles; `.elves-author-marks` adds the overlap.
 *
 * This is a pure read of the attribution runs — no highlighting here. A later
 * view layer can highlight one author's spans on hover using the same data
 * (contributors + the runs), without touching this component.
 *
 * Unknown author ids resolve to null and render nothing, so the cluster degrades
 * quietly. `verb` frames the tooltip ("Written by" vs "Suggested by").
 */
export function AuthorMarks({
  attribution,
  verb = 'Written by',
  onHoverChange,
  corner = false,
}: {
  attribution: Attribution | null
  verb?: string
  /**
   * Notified as the pointer enters (true) / leaves (false) the mark cluster.
   * The card uses this to toggle its blame highlight — hover the authors to see
   * who wrote what. Omit it and the marks are display-only. When set, the
   * cluster also takes a pointer cursor to hint it's interactive.
   */
  onHoverChange?: (hovered: boolean) => void
  /**
   * Tuck the cluster into the card's top-right corner (absolutely positioned)
   * instead of flowing inline. Used on note cards so authorship sits opposite
   * the "Note" label rather than crowding it.
   */
  corner?: boolean
}) {
  const marks = contributors(attribution)
    .map((id) => authorInfo(id))
    .filter((info): info is NonNullable<typeof info> => !!info)
  if (marks.length === 0) return null
  const interactive = !!onHoverChange
  return (
    <span
      className={`elves-author-marks${interactive ? ' elves-author-marks--interactive' : ''}${corner ? ' elves-author-marks--corner' : ''}`}
      data-testid="author-marks"
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
    >
      {marks.map((info) => (
        <span
          key={info.id}
          className="elves-agent-mark elves-author-mark"
          data-testid="card-agent-mark"
          data-agent={info.id}
          data-author={info.id}
          title={`${verb} ${info.name}`}
          style={{ color: info.accent }}
        >
          <info.Logo aria-hidden="true" focusable="false" />
        </span>
      ))}
    </span>
  )
}
