import { useEffect, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import { agentInfo } from '../shapes/agents'
import {
  PERSONALITIES, PERSONALITY_IDS, type PersonalityId, type Review,
} from '../model/reviews'
import { mechanicalGist } from '../model/summary'
import type { CommentType } from '../model/types'
import './reviewPanel.css'

interface Props {
  projectId: string | null
  editor: Editor | null
  reviews: Review[]
  onSummon: (personality: PersonalityId, focus: string | null) => void
  onDismiss: (reviewId: string) => void
  onRetry: (reviewId: string) => void
}

// Each personality's swatch borrows the label colour of its signature comment
// type, so the panel row and the comments that pass leaves on the canvas read
// as the same voice.
const TYPE_TONE: Record<CommentType, string> = {
  'needs-evidence': 'var(--elves-cc-evidence-label)',
  'weak-argument': 'var(--elves-cc-weak-label)',
  'needs-citation': 'var(--elves-cc-citation-label)',
  'wants-figure': 'var(--elves-cc-figure-label)',
  counterpoint: 'var(--elves-cc-counter-label)',
  tighten: 'var(--elves-cc-tighten-label)',
  unclear: 'var(--elves-cc-unclear-label)',
  structure: 'var(--elves-cc-structure-label)',
}

function personalityTone(id: PersonalityId): string {
  const first = PERSONALITIES[id].commentTypes[0]
  return first ? TYPE_TONE[first] : 'var(--elves-cc-freeform-label)'
}

/** The cards on the current page carrying comments from this pass. */
function passCards(editor: Editor, reviewId: string): CardShape[] {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is CardShape => s.type === 'card')
    .filter((s) => s.props.comments.some((c) => c.reviewId === reviewId))
}

function passTally(editor: Editor | null, review: Review): { open: number; total: number } {
  if (!editor) return { open: 0, total: review.commentCount }
  let open = 0
  let total = 0
  for (const card of passCards(editor, review.id)) {
    for (const c of card.props.comments) {
      if (c.reviewId !== review.id) continue
      total++
      if (!c.resolved) open++
    }
  }
  // Cards can be deleted after a pass; the completion stamp is the floor of
  // what the pass actually left, so show whichever story is larger.
  return { open, total: Math.max(total, review.commentCount) }
}

function EyeglassesIcon() {
  // Phosphor "eyeglasses" — reading glasses: the editor pulling the piece closer.
  return (
    <svg className="elves-review__icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M200,40a8,8,0,0,0,0,16,16,16,0,0,1,16,16v58.08A44,44,0,0,0,145.68,152H110.32A44,44,0,0,0,40,130.08V72A16,16,0,0,1,56,56a8,8,0,0,0,0-16A32,32,0,0,0,24,72v92a44,44,0,0,0,87.81,4h32.38A44,44,0,0,0,232,164V72A32,32,0,0,0,200,40ZM68,192a28,28,0,1,1,28-28A28,28,0,0,1,68,192Zm120,0a28,28,0,1,1,28-28A28,28,0,0,1,188,192Z" />
    </svg>
  )
}

export function ReviewPanel({ projectId, editor, reviews, onSummon, onDismiss, onRetry }: Props) {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visible = reviews.filter((r) => r.status !== 'dismissed')
  // `failed` stays in the active group (not recentDone) so it's visible with
  // its Retry button until the user dismisses it — it isn't a finished pass.
  const active = visible.filter(
    (r) => r.status === 'pending' || r.status === 'in-progress' || r.status === 'failed',
  )
  const recentDone = visible.filter((r) => r.status === 'done').slice(0, 5)
  const visibleReviews = [...active, ...recentDone]

  // Live open/total per finished pass, tracked REACTIVELY against the tldraw
  // store (useValue): a comment landing or being resolved re-renders the tally
  // without any plumbing from the canvas back to this panel.
  const tallies = useValue(
    'review pass tallies',
    () => {
      const m = new Map<string, { open: number; total: number }>()
      if (!editor) return m
      for (const r of recentDone) m.set(r.id, passTally(editor, r))
      return m
    },
    [editor, reviews],
  )

  if (!projectId) return null

  const summon = (id: PersonalityId) => {
    onSummon(id, focus.trim() ? focus.trim() : null)
    setFocus('')
  }

  // Clicking a finished pass's tally selects its flagged cards and brings them
  // into view — the report is a doorway back to the margins, not just a number.
  const jumpToPass = (review: Review) => {
    if (!editor) return
    const ids = passCards(editor, review.id).map((s) => s.id)
    if (!ids.length) return
    editor.select(...ids)
    editor.zoomToSelection({ animation: { duration: 320 } })
    setOpen(false)
  }

  return (
    <div className="elves-review" ref={ref}>
      <button
        className="elves-review__button"
        data-testid="review-button"
        aria-label="Review"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <EyeglassesIcon />
        <span>Review</span>
        {active.length > 0 && (
          <span
            className="elves-review__badge"
            data-state={
              active.some((r) => r.status === 'in-progress')
                ? 'in-progress'
                : active.some((r) => r.status === 'failed')
                  ? 'failed'
                  : 'pending'
            }
          />
        )}
      </button>
      {open && (
        <div className="elves-review__menu" role="menu" data-testid="review-menu">
          <div className="elves-review__heading">Summon a reviewer</div>
          <input
            className="elves-review__focus"
            data-testid="review-focus"
            type="text"
            placeholder="Focus (optional) — e.g. just the opening"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
          />
          {PERSONALITY_IDS.map((id) => {
            const p = PERSONALITIES[id]
            return (
              <button
                key={id}
                role="menuitem"
                className="elves-review__persona"
                data-testid={`review-summon-${id}`}
                onClick={() => summon(id)}
              >
                <span className="elves-review__swatch" style={{ background: personalityTone(id) }} />
                <span className="elves-review__persona-text">
                  <span className="elves-review__persona-name">{p.name}</span>
                  <span className="elves-review__persona-summary">{p.summary}</span>
                </span>
              </button>
            )
          })}
          {(active.length > 0 || recentDone.length > 0) && (
            <>
              <div className="elves-review__divider" role="separator" />
              <div className="elves-review__heading">Passes</div>
              {visibleReviews.map((r, index) => {
                const p = PERSONALITIES[r.personality]
                const agent = agentInfo(r.agent)
                const tally = r.status === 'done' ? (tallies.get(r.id) ?? null) : null
                const requestedAt = r.requestedAt.replace('T', ' ').replace('Z', ' UTC')
                const focusContext = mechanicalGist(r.focus ?? '', 80)
                const actionContext = `${focusContext ? `${focusContext}; ` : ''}requested ${requestedAt}; pass ${index + 1} of ${visibleReviews.length}`
                return (
                  <div
                    key={r.id}
                    className="elves-review__pass"
                    data-status={r.status}
                    data-testid={`review-pass-${r.personality}`}
                  >
                    <div className="elves-review__pass-head">
                      <span
                        className="elves-review__dot"
                        data-status={r.status}
                        style={
                          r.status === 'in-progress' && agent
                            ? { background: agent.accent }
                            : undefined
                        }
                      />
                      <span className="elves-review__pass-name">
                        {p.name}
                        {r.focus ? <span className="elves-review__pass-focus"> · {r.focus}</span> : null}
                      </span>
                      {r.status === 'pending' && (
                        <span className="elves-review__pass-state">Starting…</span>
                      )}
                      {r.status === 'in-progress' && (
                        <span className="elves-review__pass-state">
                          {agent?.name ?? r.agent} is reading…
                        </span>
                      )}
                      {tally && tally.total > 0 && (
                        <button
                          className="elves-review__tally"
                          data-testid={`review-tally-${r.personality}`}
                          title="Show this pass's comments on the canvas"
                          onClick={() => jumpToPass(r)}
                        >
                          {tally.open > 0 ? `${tally.open} open · ${tally.total} notes` : `${tally.total} notes`}
                        </button>
                      )}
                      {r.status === 'failed' && (
                        <button
                          className="elves-review__retry"
                          data-testid={`review-retry-${r.personality}`}
                          title="Try this pass again"
                          onClick={() => onRetry(r.id)}
                        >
                          Retry
                        </button>
                      )}
                      <button
                        className="elves-review__dismiss"
                        data-testid={`review-dismiss-${r.personality}`}
                        title={
                          r.status === 'done' || r.status === 'failed'
                            ? 'Clear from panel'
                            : 'Cancel this pass'
                        }
                        aria-label={
                          r.status === 'done'
                            ? `Clear ${p.name} review from panel: ${actionContext}`
                            : r.status === 'failed'
                              ? `Clear failed ${p.name} review from panel: ${actionContext}`
                            : `Cancel ${p.name} review: ${actionContext}`
                        }
                        onClick={() => onDismiss(r.id)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                    {r.status === 'done' && r.verdict && (
                      <div className="elves-review__verdict" data-testid="review-verdict">{r.verdict}</div>
                    )}
                    {r.status === 'failed' && r.error && (
                      <div className="elves-review__error" data-testid="review-error">{r.error}</div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
