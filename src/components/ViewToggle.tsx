import './viewToggle.css'

/** Canvas only · split · draft only — the three ways to look at a piece. */
export type ViewState = 'canvas' | 'split' | 'draft'

/** Cycle order for the keyboard shortcut (⌘/Ctrl + \). */
export const VIEW_ORDER: ViewState[] = ['canvas', 'split', 'draft']

const OPTIONS: { value: ViewState; label: string; hint: string; Icon: () => JSX.Element }[] = [
  { value: 'canvas', label: 'Canvas', hint: 'Canvas only', Icon: CanvasIcon },
  { value: 'split', label: 'Split', hint: 'Canvas + draft', Icon: SplitIcon },
  { value: 'draft', label: 'Draft', hint: 'Draft only', Icon: DraftIcon },
]

export function ViewToggle({
  view,
  onChange,
}: {
  view: ViewState
  onChange: (v: ViewState) => void
}) {
  return (
    <div className="elves-view-toggle" role="group" aria-label="View" data-testid="view-toggle">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-active={view === opt.value}
          data-testid={`view-${opt.value}`}
          aria-pressed={view === opt.value}
          title={opt.hint}
          onClick={() => onChange(opt.value)}
        >
          <opt.Icon />
          <span className="elves-view-toggle__label">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

function CanvasIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function DraftIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="3" y1="4.5" x2="13" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="3" y1="11.5" x2="9.5" y2="11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
