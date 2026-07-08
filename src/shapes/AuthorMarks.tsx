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
}: {
  attribution: Attribution | null
  verb?: string
}) {
  const marks = contributors(attribution)
    .map((id) => authorInfo(id))
    .filter((info): info is NonNullable<typeof info> => !!info)
  if (marks.length === 0) return null
  return (
    <span className="elves-author-marks" data-testid="author-marks">
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
