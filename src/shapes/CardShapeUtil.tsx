import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds, resizeBox,
  stopEventPropagation,
  type Editor, type Geometry2d, type TLResizeInfo, type TLShapePartial,
} from 'tldraw'
import { useLayoutEffect, type CSSProperties, type ReactNode } from 'react'
import type { CardKind, NoteKind, Origin, Comment, Reference, FigureStatus } from '../model/types'
import { makeProseCardProps } from '../model/cards'
import { nextFigureStatus } from '../model/figures'
import { cardGist } from '../model/summary'
import { visibleComments, resolveComment } from '../model/comments'
import { assetUrl } from '../client/assets'
import { measuredCardHeight, measuredReferenceHeight, measuredFigureHeight } from './autosize'
import { shouldShowGist, gistFontSize } from './summaryView'
import { mergedMembers, isExpanded, toggleExpanded } from './mergeView'
import { ReferenceCardFace } from './ReferenceCardFace'
import { agentInfo } from './agents'
import { presenceMode } from '../client/presence'
import './card.css'

export type CardShape = TLBaseShape<'card', {
  w: number
  h: number
  kind: CardKind
  noteKind: NoteKind | null
  origin: Origin | null
  text: string
  authoredBy: string | null
  comments: Comment[]
  mergedInto: string | null
  draftExcluded: boolean
  assetId: string | null
  reference: Reference | null
  figureTitle: string
  figureStatus: FigureStatus | null
  summary: string | null
  summaryOfHash: string | null
  summaryBy: string | null
  summaryAt: string | null
}>

// Validator for the structured reference metadata (noteKind === 'reference').
const referenceValidator = T.object({
  url: T.string,
  refType: T.literalEnum('paper', 'article', 'book', 'software', 'social', 'video', 'wiki', 'link'),
  title: T.nullable(T.string),
  authors: T.arrayOf(T.string),
  siteName: T.nullable(T.string),
  year: T.nullable(T.number),
  venue: T.nullable(T.string),
  description: T.nullable(T.string),
  faviconAssetId: T.nullable(T.string),
  thumbnailAssetId: T.nullable(T.string),
  doi: T.nullable(T.string),
  arxivId: T.nullable(T.string),
  fetchedBy: T.nullable(T.literalEnum('unfurl', 'claude', 'user')),
  fetchedAt: T.nullable(T.string),
})

export function addCommentsUp(props: Record<string, unknown>): void {
  props.comments = []
  props.mergedInto = null
}

export function addAssetIdUp(props: Record<string, unknown>): void {
  props.assetId = null
}

export function addReferenceUp(props: Record<string, unknown>): void {
  props.reference = null
}

export function addSummaryUp(props: Record<string, unknown>): void {
  props.summary = null
  props.summaryOfHash = null
  props.summaryBy = null
  props.summaryAt = null
}

// Records which agent authored a note card (an agent id like 'claude'), or null
// for a human author. Existing cards predate the field, so default them to null:
// we can't retroactively know which past cards an agent made.
export function addAuthoredByUp(props: Record<string, unknown>): void {
  props.authoredBy = null
}

// The draft-exclude flag postdates every existing card. Default them to false —
// a card is part of the linear draft unless the user deliberately excludes it,
// so old canvases compile in full exactly as they read on the board.
export function addDraftExcludedUp(props: Record<string, unknown>): void {
  props.draftExcluded = false
}

// The figure-card fields (a third card kind). Existing cards are notes or prose,
// never figures, so default them to the "not a figure" shape: an empty title and
// no status. A figure card is only ever born via makeFigureCardProps.
export function addFigureUp(props: Record<string, unknown>): void {
  props.figureTitle = ''
  props.figureStatus = null
}

// Card kind 'source' was renamed to 'note', and its sub-kind prop `sourceKind`
// to `noteKind`, when "note" became the canonical word for these cards. Idempotent
// on purpose: the server pre-converts canvas.json on disk before serving, so this
// may run on props that are already in the new shape — guarding on the old names
// means a double pass is a no-op rather than clobbering good data.
export function renameSourceToNoteUp(props: Record<string, unknown>): void {
  if (props.kind === 'source') props.kind = 'note'
  if ('sourceKind' in props) {
    props.noteKind = props.sourceKind
    delete props.sourceKind
  }
}

export function renameSourceToNoteDown(props: Record<string, unknown>): void {
  if (props.kind === 'note') props.kind = 'source'
  if ('noteKind' in props) {
    props.sourceKind = props.noteKind
    delete props.noteKind
  }
}

const cardVersions = createShapePropsMigrationIds('card', {
  AddComments: 1, AddAssetId: 2, AddReference: 3, AddSummary: 4, RenameSourceToNote: 5,
  AddAuthoredBy: 6, AddDraftExcluded: 7, AddFigure: 8,
})

export const cardMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: cardVersions.AddComments,
      up: (props) => addCommentsUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        delete p.comments
        delete p.mergedInto
      },
    },
    {
      id: cardVersions.AddAssetId,
      up: (props) => addAssetIdUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).assetId
      },
    },
    {
      id: cardVersions.AddReference,
      up: (props) => addReferenceUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).reference
      },
    },
    {
      id: cardVersions.AddSummary,
      up: (props) => addSummaryUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        delete p.summary
        delete p.summaryOfHash
        delete p.summaryBy
        delete p.summaryAt
      },
    },
    {
      id: cardVersions.RenameSourceToNote,
      up: (props) => renameSourceToNoteUp(props as Record<string, unknown>),
      down: (props) => renameSourceToNoteDown(props as Record<string, unknown>),
    },
    {
      id: cardVersions.AddAuthoredBy,
      up: (props) => addAuthoredByUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).authoredBy
      },
    },
    {
      id: cardVersions.AddDraftExcluded,
      up: (props) => addDraftExcludedUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).draftExcluded
      },
    },
    {
      id: cardVersions.AddFigure,
      up: (props) => addFigureUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        delete p.figureTitle
        delete p.figureStatus
      },
    },
  ],
})

/**
 * Grows a card's height to fit its text (measured at the card's current width),
 * so a card never clips its own content. Runs after layout — and again once web
 * fonts are ready, since the first measure can happen before Inter has loaded —
 * and only writes back when the height actually changed, so it settles in one
 * pass instead of looping. Width stays user-controlled; height follows the text.
 */
function AutosizeCard({
  editor, shape, children,
}: { editor: Editor; shape: CardShape; children: ReactNode }) {
  const { text, w, h, kind, noteKind, reference, figureTitle } = shape.props
  useLayoutEffect(() => {
    let cancelled = false
    const fit = () => {
      if (cancelled) return
      const cur = editor.getShape<CardShape>(shape.id)
      if (!cur || cur.props.mergedInto || cur.props.noteKind === 'image') return
      const want = cur.props.kind === 'figure'
        ? measuredFigureHeight(editor, cur.props.figureTitle, cur.props.text, cur.props.w)
        : cur.props.noteKind === 'reference' && cur.props.reference
        ? measuredReferenceHeight(editor, cur.props.reference, cur.props.w)
        : measuredCardHeight(editor, cur.props.text, cur.props.w, cur.props.kind === 'note')
      if (Math.abs(want - cur.props.h) > 1) {
        editor.updateShape<CardShape>({ id: cur.id, type: 'card', props: { h: want } })
      }
    }
    fit()
    document.fonts?.ready?.then(fit)
    return () => { cancelled = true }
  }, [editor, shape.id, text, w, h, kind, noteKind, reference, figureTitle])
  return <>{children}</>
}

// An eye (in the draft) / struck-through eye (excluded), for the draft-exclude
// toggle. Phosphor-style single-path glyphs, sized by the button's font.
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
      {off ? (
        <path d="M228,175a8,8,0,0,1-10.92-3l-19-33.2A123.23,123.23,0,0,1,162,155.46l5.87,35.22a8,8,0,0,1-6.58,9.21,8.4,8.4,0,0,1-1.32.11,8,8,0,0,1-7.88-6.69l-5.77-34.58a133.06,133.06,0,0,1-36.68,0l-5.77,34.58A8,8,0,0,1,96,200.11L101.85,165A123.31,123.31,0,0,1,57,138.76L38,172a8,8,0,1,1-13.9-7.9l20.15-35.25A153.06,153.06,0,0,1,28.68,113.4a8,8,0,1,1,11.16-11.46c16.83,16.39,42.34,35.9,88.16,35.9s71.33-19.51,88.16-35.9a8,8,0,0,1,11.16,11.46,153.06,153.06,0,0,1-15.53,15.41L232,164.09A8,8,0,0,1,228,175Z" />
      ) : (
        <path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z" />
      )}
    </svg>
  )
}

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const
  static override migrations = cardMigrations
  static override props: RecordProps<CardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('note', 'prose', 'figure'),
    noteKind: T.nullable(T.literalEnum('text', 'image', 'reference')),
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed', 'transcribed', 'reference')),
    text: T.string,
    authoredBy: T.nullable(T.string),
    comments: T.arrayOf(
      T.object({
        id: T.string,
        type: T.nullable(T.literalEnum('needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure')),
        text: T.string,
        resolved: T.boolean,
        author: T.literalEnum('claude'),
      }),
    ),
    mergedInto: T.nullable(T.string),
    draftExcluded: T.boolean,
    assetId: T.nullable(T.string),
    reference: T.nullable(referenceValidator),
    figureTitle: T.string,
    figureStatus: T.nullable(T.literalEnum('idea', 'sketched', 'final')),
    summary: T.nullable(T.string),
    summaryOfHash: T.nullable(T.string),
    summaryBy: T.nullable(T.string),
    summaryAt: T.nullable(T.string),
  }

  getDefaultProps(): CardShape['props'] {
    // Delegate to the unit-tested model factory so defaults stay DRY.
    return makeProseCardProps()
  }

  getGeometry(shape: CardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: CardShape) {
    // Cards merged away into a representative are hidden from the canvas by
    // App's getShapeVisibility (rendering AND hit-testing), so this component
    // never runs for them — no invisible "ghost" shape. The representative shows
    // them instead: a stack underneath, and a fan-out on demand.
    const members = mergedMembers(this.editor.getCurrentPageShapes(), shape.id)
    const mergedCount = members.length
    const expanded = mergedCount > 0 && isExpanded(shape.id)
    const { kind, text, noteKind, assetId, reference, figureTitle, figureStatus, draftExcluded } = shape.props
    const isImage = noteKind === 'image' && !!assetId
    const isReference = noteKind === 'reference' && !!reference
    const isFigure = kind === 'figure'
    const isEditing = this.editor.getEditingShapeId() === shape.id
    // The draft-exclude affordance is only meaningful on PROSE cards (the linear
    // draft is prose-only in v1). Show it when the card is the sole selection (so
    // you can opt it out) or whenever it's already excluded (so it's always
    // visible WHY that card isn't compiling into the draft).
    const isProse = kind === 'prose'
    const selected = this.editor.getOnlySelectedShapeId() === shape.id
    const showExcludeToggle = isProse && (selected || draftExcluded)
    // Zoomed far out, a summarized card shows its gist so the piece reads at a
    // glance. getZoomLevel is reactive, so this re-renders as the user zooms;
    // the gist font counter-scales with zoom to stay a readable on-screen size.
    const zoom = this.editor.getZoomLevel()
    const showGist = !isEditing && shouldShowGist(zoom, shape.props)
    const comments = visibleComments(shape.props.comments)
    // Ephemeral agent presence: a soft orange glow when the agent is looking at
    // (read_cards) or has just acted on this card. Reading the atom here is
    // reactive (this component is tldraw-`track`ed, same as the zoom read above),
    // so the glow appears and fades on its own. Lives entirely outside the
    // document — never persisted, never in undo history.
    const presence = presenceMode(shape.id)
    // The agent (if any) that authored this note via the MCP — drives the small
    // logo mark beside the NOTE label. null for human-authored or unknown ids.
    const agent = agentInfo(shape.props.authoredBy)
    // The "N merged" chip is a button: it toggles the ephemeral peek that fans
    // the merged cards out to the right. stopEventPropagation keeps the click
    // from starting a canvas drag / selecting the card.
    const mergedBadge =
      mergedCount > 0 ? (
        <button
          type="button"
          className="elves-merged"
          data-testid="merged-badge"
          aria-expanded={expanded}
          title={expanded ? 'Hide merged cards' : 'Show merged cards'}
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e)
            toggleExpanded(shape.id)
          }}
        >
          ⊕ {mergedCount} merged
        </button>
      ) : null
    return (
      <AutosizeCard editor={this.editor} shape={shape}>
      <HTMLContainer style={{ overflow: 'visible' }}>
        <div
          className="elves-card-wrap"
          style={{ position: 'relative', width: '100%', height: '100%' }}
          data-presence={presence ?? undefined}
        >
          {/* The agent-presence glow. Always rendered (so fade-out is a smooth
              opacity transition, not a hard cut); the halo itself is driven by
              the wrap's data-presence attribute. aria-hidden — it's ambient. */}
          <div className="elves-presence" aria-hidden="true" data-testid="presence-glow" />
          {/* Draft-exclude toggle: keep this prose aside out of the linear draft
              (and read_draft). The button carries its own state — an eye when in
              the draft, struck-through when excluded — and stays visible while
              excluded so the marker explains itself. */}
          {showExcludeToggle && (
            <button
              type="button"
              className="elves-draft-exclude"
              data-testid="draft-exclude-toggle"
              data-excluded={draftExcluded}
              aria-pressed={draftExcluded}
              title={draftExcluded ? 'Excluded from the draft — click to include' : 'Exclude from the draft'}
              onPointerDown={stopEventPropagation}
              onClick={(e) => {
                stopEventPropagation(e)
                this.editor.updateShape<CardShape>({
                  id: shape.id, type: 'card', props: { draftExcluded: !draftExcluded },
                })
              }}
            >
              <EyeIcon off={draftExcluded} />
              {draftExcluded && <span className="elves-draft-exclude__label">Not in draft</span>}
            </button>
          )}
          {/* A short paper stack peeking out behind the representative signals
              "there's more collapsed here". Fixed 1–2 edges, quiet until the
              badge is engaged; hidden while fanned out or zoomed to gist. */}
          {mergedCount > 0 && !expanded && !showGist && (
            <div className="elves-merge-stack" aria-hidden="true" data-testid="merge-stack">
              {Array.from({ length: Math.min(mergedCount, 2) }).map((_, i) => (
                <div
                  key={i}
                  className="elves-merge-stack__edge"
                  style={{ '--edge': i + 1 } as CSSProperties}
                />
              ))}
            </div>
          )}
          <div
            className={`elves-card elves-card--${kind}${isImage ? ' elves-card--image' : ''}${isReference ? ' elves-card--reference' : ''}${showGist ? ' elves-card--gist' : ''}${draftExcluded ? ' elves-card--excluded' : ''}`}
            // In gist mode a short card's box (sized to its full text at 15px) may
            // be shorter than the gist at the uniform gist size, so let the card
            // grow to fit rather than clip. Long cards keep min-height 100% and
            // are unchanged (their tall box already holds the short gist).
            style={
              showGist
                ? { width: '100%', height: 'auto', minHeight: '100%', overflow: 'visible' }
                : { width: '100%', height: '100%' }
            }
          >
            {isImage ? (
              // Image cards are just the image — edge-to-edge, no label, no chrome.
              <img
                className="elves-card__image"
                src={assetUrl(assetId!)}
                alt=""
                draggable={false}
                data-testid="card-image"
              />
            ) : isReference ? (
              // Reference cards render a type-adaptive face; the annotation text
              // (shape.props.text) stays the user's own words, edited elsewhere.
              <>
                {mergedBadge}
                <ReferenceCardFace reference={reference} />
              </>
            ) : isFigure ? (
              // Figure cards plan a visual: a dashed sketch-frame with an image
              // glyph, a prominent title over a smaller description, and a status
              // chip that cycles idea → sketched → final. Title and description
              // are both editable; editing either claims authorship (clears any
              // agent mark), the way renaming a section flips its authoredBy.
              <>
                <div className="elves-figure__eyebrow">
                  <span className="elves-figure__glyph" aria-hidden="true">
                    <svg viewBox="0 0 256 256" fill="currentColor">
                      <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z" />
                    </svg>
                  </span>
                  <span className="elves-badge" data-testid="card-badge">Figure</span>
                  {agent && (
                    <span
                      className="elves-agent-mark"
                      data-testid="card-agent-mark"
                      data-agent={agent.id}
                      title={`Suggested by ${agent.name}`}
                      style={{ color: agent.accent }}
                    >
                      <agent.Logo aria-hidden="true" focusable="false" />
                    </span>
                  )}
                </div>
                {/* Status chip — a button that cycles the figure's status. Tucked
                    into the top-right corner (absolute), pointer-events:all so the
                    click lands on it and not the canvas underneath. */}
                <button
                  type="button"
                  className="elves-figure__status"
                  data-testid="figure-status"
                  data-status={figureStatus ?? 'idea'}
                  title="Cycle status: idea → sketched → final"
                  onPointerDown={stopEventPropagation}
                  onClick={(e) => {
                    stopEventPropagation(e)
                    this.editor.updateShape<CardShape>({
                      id: shape.id, type: 'card',
                      props: { figureStatus: nextFigureStatus(figureStatus ?? 'idea') },
                    })
                  }}
                >
                  {figureStatus ?? 'idea'}
                </button>
                {isEditing ? (
                  <>
                    <input
                      className="elves-figure__title-input"
                      data-testid="figure-title-input"
                      autoFocus
                      defaultValue={figureTitle}
                      placeholder="Figure title"
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        this.editor.updateShape<CardShape>({
                          id: shape.id, type: 'card',
                          props: { figureTitle: e.currentTarget.value, authoredBy: null },
                        })
                      }
                    />
                    <textarea
                      className="elves-figure__desc-input"
                      data-testid="figure-desc-input"
                      defaultValue={text}
                      placeholder="What should this visual show?"
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        this.editor.updateShape<CardShape>({
                          id: shape.id, type: 'card',
                          props: { text: e.currentTarget.value, authoredBy: null },
                        })
                      }
                    />
                  </>
                ) : (
                  <>
                    <div
                      className="elves-figure__title"
                      data-testid="figure-title"
                      data-empty={figureTitle ? undefined : 'true'}
                    >
                      {figureTitle || 'Untitled figure'}
                    </div>
                    <div className="elves-figure__desc" data-testid="figure-desc">{text}</div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Zoomed out, hide the Note/merged chrome so the gist owns the
                    whole card and reads at a glance. */}
                {!showGist && kind === 'note' && (
                  <div className="elves-badge-row">
                    <span className="elves-badge" data-testid="card-badge">Note</span>
                    {/* Agent authorship: a small logo, tinted the agent's accent,
                        tucked right of the label so it reads "written by <agent>". */}
                    {agent && (
                      <span
                        className="elves-agent-mark"
                        data-testid="card-agent-mark"
                        data-agent={agent.id}
                        title={`Written by ${agent.name}`}
                        style={{ color: agent.accent }}
                      >
                        <agent.Logo aria-hidden="true" focusable="false" />
                      </span>
                    )}
                  </div>
                )}
                {!showGist && mergedBadge}
                {isEditing ? (
                  <textarea
                    className="elves-card__editor"
                    autoFocus
                    defaultValue={text}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      this.editor.updateShape<CardShape>({
                        id: shape.id,
                        type: 'card',
                        props: { text: e.currentTarget.value },
                      })
                    }
                  />
                ) : showGist ? (
                  <div
                    className="elves-card__text elves-card__text--gist"
                    data-testid="card-gist"
                    style={{ fontSize: gistFontSize(zoom) }}
                  >
                    {cardGist(shape.props)}
                  </div>
                ) : (
                  <div className="elves-card__text" data-testid="card-text">{text}</div>
                )}
              </>
            )}
          </div>
          {!showGist && comments.length > 0 && (
            <div className="elves-comments" onPointerDown={(e) => e.stopPropagation()}>
              {comments.map((c) => (
                <div
                  key={c.id}
                  className="elves-comment"
                  data-type={c.type ?? 'freeform'}
                >
                  <div className="elves-comment__body">
                    {c.type && <span className="elves-comment__type">{c.type}</span>}
                    <span className="elves-comment__text">{c.text}</span>
                  </div>
                  <button
                    className="elves-comment__resolve"
                    data-testid="comment-resolve"
                    title="Resolve"
                    onClick={() =>
                      this.editor.updateShape<CardShape>({
                        id: shape.id, type: 'card',
                        props: { comments: resolveComment(shape.props.comments, c.id) },
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* The peek: the merged cards fanned out to the right, read-only, each
              showing its full text so you can see exactly what was collapsed.
              stopPropagation lets you click/select the text without the canvas
              treating it as a drag. */}
          {expanded && (
            <div
              className="elves-merge-fan"
              data-testid="merge-fan"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {members.map((m) => (
                <div key={m.id} className="elves-merge-fan__card" data-testid="merge-fan-card">
                  {m.props.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </HTMLContainer>
      </AutosizeCard>
    )
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} />
  }

  override canResize() { return true }
  override canEdit() { return true }
  // Rotation has no role in this spatial-narrative model: resolvePageXY (the
  // server/MCP compile in server/digest.ts) walks page x/y additively and is
  // only exact when no ancestor is rotated. tldraw has no canRotate() flag, so
  // we hide the interactive handle AND veto the rotate-90 actions (which don't
  // check hideRotateHandle) by snapping every onRotate back to the shape's
  // pre-rotation pose. Together these keep the Draft pane and read_draft from
  // ever disagreeing on reading order. See issue #39.
  override hideRotateHandle() { return true }
  override onRotate(initial: CardShape): TLShapePartial<CardShape> {
    return { id: initial.id, type: 'card', x: initial.x, y: initial.y, rotation: initial.rotation }
  }
  override onResize(shape: CardShape, info: TLResizeInfo<CardShape>) {
    // Let the user set the width by dragging; height always fits the text at
    // that width, so a resize can't clip content or leave dead space.
    const next = resizeBox(shape, info)
    if (shape.props.noteKind === 'image') return next
    const w = next.props?.w ?? shape.props.w
    const h = shape.props.kind === 'figure'
      ? measuredFigureHeight(this.editor, shape.props.figureTitle, shape.props.text, w)
      : shape.props.noteKind === 'reference' && shape.props.reference
      ? measuredReferenceHeight(this.editor, shape.props.reference, w)
      : measuredCardHeight(this.editor, shape.props.text, w, shape.props.kind === 'note')
    return { ...next, props: { ...next.props, h } }
  }
}
