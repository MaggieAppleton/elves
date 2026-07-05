import type { ViewState } from '../client/viewMachine'

/**
 * Directional drawer handle. The draft pane is a drawer anchored to the right
 * edge; each chevron points the way its edge will travel:
 *   «  more draft  (canvas → split → draft)
 *   »  less draft  (draft → split → canvas)
 * Only the reachable chevrons are shown for the current view.
 */
export function DraftDrawerControls({
  view,
  split,
  onExpand,
  onCollapse,
}: {
  view: ViewState
  split: number
  onExpand: () => void
  onCollapse: () => void
}) {
  // Canvas: drawer closed — a half-hidden tab on the right edge pulls it out.
  if (view === 'canvas') {
    return (
      <div className="elves-drawer-tab">
        <button
          type="button"
          data-testid="draft-open"
          aria-label="Open draft"
          title="Open draft"
          onClick={onExpand}
        >
          <ChevronLeft />
        </button>
      </div>
    )
  }

  // Draft (full): drawer fills the screen — a single » parks at top-left.
  if (view === 'draft') {
    return (
      <div className="elves-drawer-handle elves-drawer-handle--full">
        <button
          type="button"
          data-testid="draft-collapse"
          aria-label="Collapse draft to split"
          title="Collapse draft"
          onClick={onCollapse}
        >
          <ChevronRight />
        </button>
      </div>
    )
  }

  // Split: handle rides the top of the divider (left = the split boundary).
  return (
    <div
      className="elves-drawer-handle elves-drawer-handle--split"
      style={{ left: `${split * 100}%` }}
    >
      <button
        type="button"
        data-testid="draft-expand"
        aria-label="Expand draft to full"
        title="Expand draft"
        onClick={onExpand}
      >
        <ChevronLeft />
      </button>
      <button
        type="button"
        data-testid="draft-collapse"
        aria-label="Close draft"
        title="Close draft"
        onClick={onCollapse}
      >
        <ChevronRight />
      </button>
    </div>
  )
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
