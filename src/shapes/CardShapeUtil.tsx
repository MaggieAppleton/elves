import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds, resizeBox,
  stopEventPropagation,
  type Editor, type Geometry2d, type TLResizeInfo, type TLShapePartial,
} from 'tldraw'
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { CardKind, NoteKind, Origin, Comment, Reference, FigureStatus, Attribution } from '../model/types'
import { makeProseCardProps, canConvertNoteToProse, noteToProseProps, canConvertProseToNote, proseToNoteProps } from '../model/cards'
import { reattribute, USER_AUTHOR } from '../model/attribution'
import { AuthorMarks } from './AuthorMarks'
import { BlameText, hasAgentRun } from './BlameText'
import { nextFigureStatus } from '../model/figures'
import { cardGist, commentGist, mechanicalGist } from '../model/summary'
import { visibleComments, resolveComment } from '../model/comments'
import { assetUrl } from '../client/assets'
import { measuredCardHeight, measuredReferenceHeight, measuredFigureHeight, fittedGistFontSize, PROSE_TEXT_MIN } from './autosize'
import { shouldShowGist, gistFontSize } from './summaryView'
import { mergedMembers, isExpanded, toggleExpanded } from './mergeView'
import { ReferenceCardFace } from './ReferenceCardFace'
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
  attribution: Attribution | null
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

// Comments gained a nullable `reviewId` tying each to the review pass that made
// it (see src/model/reviews.ts). Every existing comment predates review passes,
// so default them to null — a comment made outside any pass.
export function addCommentReviewIdUp(props: Record<string, unknown>): void {
  const comments = props.comments
  if (Array.isArray(comments)) {
    props.comments = comments.map((c) => ({ reviewId: null, ...(c as Record<string, unknown>) }))
  }
}

// Every comment predating this field gets a comment-level summary, mirroring
// addSummaryUp for the card itself: default to "no summary generated yet" so
// reconciliation treats it exactly like a freshly-added comment.
export function addCommentSummaryUp(props: Record<string, unknown>): void {
  const comments = Array.isArray(props.comments) ? (props.comments as Record<string, unknown>[]) : []
  for (const c of comments) {
    c.summary = null
    c.summaryOfHash = null
    c.summaryBy = null
    c.summaryAt = null
  }
}

// Seeds per-character authorship from a card's last-writer + text. An existing
// card has one author for its whole body — the human (authoredBy null → 'user')
// or the agent that wrote it — so its attribution is one run of that author over
// the full text length. Empty text carries an empty attribution (nothing to
// attribute). Later edits split this into multiple runs (see reattribute).
export function addAttributionUp(props: Record<string, unknown>): void {
  const text = typeof props.text === 'string' ? props.text : ''
  const author = typeof props.authoredBy === 'string' ? props.authoredBy : 'user'
  props.attribution = text.length ? [{ author, length: text.length }] : []
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
  AddAuthoredBy: 6, AddDraftExcluded: 7, AddFigure: 8, AddAttribution: 9, AddCommentSummary: 10,
  AddCommentReviewId: 11,
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
    {
      id: cardVersions.AddAttribution,
      up: (props) => addAttributionUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).attribution
      },
    },
    {
      id: cardVersions.AddCommentSummary,
      up: (props) => addCommentSummaryUp(props as Record<string, unknown>),
      down: (props) => {
        const comments = (props as Record<string, unknown>).comments
        if (Array.isArray(comments)) {
          for (const c of comments as Record<string, unknown>[]) {
            delete c.summary
            delete c.summaryOfHash
            delete c.summaryBy
            delete c.summaryAt
          }
        }
      },
    },
    {
      id: cardVersions.AddCommentReviewId,
      up: (props) => addCommentReviewIdUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        if (Array.isArray(p.comments)) {
          p.comments = p.comments.map((c) => {
            const { reviewId: _drop, ...rest } = c as Record<string, unknown>
            return rest
          })
        }
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
        ? measuredReferenceHeight(editor, cur.props.reference, cur.props.text, cur.props.w)
        : measuredCardHeight(
            editor, cur.props.text, cur.props.w,
            cur.props.kind === 'note' || cur.props.kind === 'prose',
            cur.props.kind === 'prose' ? PROSE_TEXT_MIN : 0,
          )
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

// Phosphor "ArrowsLeftRight" (regular), for the note↔prose convert toggle.
// Inlined to keep the shape renderer import-light.
function ArrowsLeftRightIcon() {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M213.66,181.66l-32,32a8,8,0,0,1-11.32-11.32L188.69,184H48a8,8,0,0,1,0-16H188.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,213.66,181.66Zm-139.32-64a8,8,0,0,0,11.32-11.32L67.31,88H208a8,8,0,0,0,0-16H67.31L85.66,53.66A8,8,0,0,0,74.34,42.34l-32,32a8,8,0,0,0,0,11.32Z" />
    </svg>
  )
}

// Phosphor "Trash" (regular), for deleting a merged card from the fan-out peek.
function TrashIcon() {
  return (
    <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
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
    // Per-character authorship runs; nullable for legacy cards (see reattribute).
    attribution: T.nullable(T.arrayOf(T.object({ author: T.string, length: T.number }))),
    comments: T.arrayOf(
      T.object({
        id: T.string,
        type: T.nullable(T.literalEnum(
          'needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure',
          'counterpoint', 'tighten', 'unclear', 'structure',
        )),
        text: T.string,
        resolved: T.boolean,
        // Any agent id (e.g. 'claude', 'codex'); resolved through the agent registry.
        author: T.string,
        // The review pass that made it (a Review id), or null outside any pass.
        reviewId: T.nullable(T.string),
        // A comment's own model-authored gist, mirroring a card's summary fields.
        summary: T.nullable(T.string),
        summaryOfHash: T.nullable(T.string),
        summaryBy: T.nullable(T.string),
        summaryAt: T.nullable(T.string),
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
    const selected = this.editor.getOnlySelectedShapeId() === shape.id
    // "Convert to prose" is offered only on a solely-selected TEXT note — its
    // `text` is the user's own words, ready to join the draft. Image/reference
    // notes (annotation / structured data) and prose cards never show it.
    const showConvertToProse = selected && canConvertNoteToProse(shape.props)
    const showConvertToNote = selected && canConvertProseToNote(shape.props)
    // Zoomed far out, a summarized card shows its gist so the piece reads at a
    // glance. getZoomLevel is reactive, so this re-renders as the user zooms;
    // the gist font counter-scales with zoom to stay a readable on-screen size.
    const zoom = this.editor.getZoomLevel()
    const showGist = !isEditing && shouldShowGist(zoom, shape.props)
    const comments = visibleComments(shape.props.comments)
    const pageCards = this.editor.getCurrentPageShapes()
      .filter((candidate) => candidate.type === 'card')
      .sort((a, b) => a.id.localeCompare(b.id))
    const cardNumber = pageCards.findIndex((candidate) => candidate.id === shape.id) + 1
    // Ephemeral agent presence: a soft orange glow when the agent is looking at
    // (read_cards) or has just acted on this card. Reading the atom here is
    // reactive (this component is tldraw-`track`ed, same as the zoom read above),
    // so the glow appears and fades on its own. Lives entirely outside the
    // document — never persisted, never in undo history.
    const presence = presenceMode(shape.id)
    // Blame reveal: hovering the stacked author marks tints each agent's runs in
    // the card body (see BlameText). Only offered when there's a resolvable agent
    // run to reveal — an all-human card's marks stay display-only.
    const [blameActive, setBlameActive] = useState(false)
    const blameHoverable = hasAgentRun(shape.props.attribution)
    const onBlameHover = blameHoverable ? setBlameActive : undefined
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
            // The card box always fills its shape geometry and clips (overflow:hidden
            // from .elves-card) — in gist mode too. The gist font is fitted to this
            // box (fittedGistFontSize below), so the summary shows in full; clipping
            // is just a hard backstop so nothing can ever overlap the card beneath it.
            style={{ width: '100%', height: '100%' }}
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
              // Reference cards render a type-adaptive face — bibliographic
              // metadata (title/authors/etc.) is always read-only, sourced from
              // the reference itself. The annotation (shape.props.text) is the
              // user's own words underneath it: an editable textarea while
              // editing, mirroring the prose/note pattern below, and a plain
              // line of text otherwise.
              <>
                {mergedBadge}
                <ReferenceCardFace reference={reference} />
                {isEditing ? (
                  <textarea
                    className="elves-ref__annotation-input"
                    data-testid="ref-annotation-input"
                    autoFocus
                    defaultValue={text}
                    placeholder="Add your own notes…"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const value = e.currentTarget.value
                      this.editor.updateShape<CardShape>({
                        id: shape.id, type: 'card',
                        props: {
                          text: value,
                          attribution: reattribute(shape.props.text, value, shape.props.attribution, USER_AUTHOR),
                        },
                      })
                    }}
                  />
                ) : text ? (
                  <div className="elves-ref__annotation" data-testid="ref-annotation">{text}</div>
                ) : null}
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
                  <AuthorMarks attribution={shape.props.attribution} verb="Suggested by" onHoverChange={onBlameHover} />
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
                      onChange={(e) => {
                        const value = e.currentTarget.value
                        this.editor.updateShape<CardShape>({
                          id: shape.id, type: 'card',
                          props: {
                            text: value,
                            authoredBy: null,
                            attribution: reattribute(shape.props.text, value, shape.props.attribution, USER_AUTHOR),
                          },
                        })
                      }}
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
                    <div
                    className={`elves-figure__desc${blameActive ? ' elves-blame-active' : ''}`}
                    data-testid="figure-desc"
                  >
                    <BlameText text={text} attribution={shape.props.attribution} />
                  </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Top-right corner cluster: authorship mark(s) and the note↔prose
                    convert toggle sit together, opposite the "Note"/"Prose" label.
                    Author marks stack every contributor to a NOTE's text (prose is
                    human by definition, so it carries no mark); the convert toggle
                    appears only while the card is solely selected. Hidden in gist
                    mode with the rest of the chrome. */}
                {!showGist && (kind === 'note' || kind === 'prose') && (
                  <div className="elves-card__corner">
                    {/* Merged chip sits left of the author mark(s) — same flex row,
                        so gap keeps them apart instead of stacking in the corner. */}
                    {mergedBadge}
                    {kind === 'note' && (
                      <AuthorMarks
                        attribution={shape.props.attribution}
                        verb="Written by"
                        onHoverChange={onBlameHover}
                      />
                    )}
                    {/* Promote a text note into the draft (note → prose). */}
                    {showConvertToProse && (
                      <button
                        type="button"
                        className="elves-convert-prose"
                        data-testid="convert-to-prose"
                        title="Switch to prose"
                        aria-label="Switch to prose"
                        onPointerDown={stopEventPropagation}
                        onClick={(e) => {
                          stopEventPropagation(e)
                          this.editor.updateShape<CardShape>({
                            id: shape.id, type: 'card',
                            props: noteToProseProps(shape.props),
                          })
                        }}
                      >
                        <ArrowsLeftRightIcon />
                      </button>
                    )}
                    {/* The inverse: demote a prose card back to a note (out of the
                        draft, editable by agents again). */}
                    {showConvertToNote && (
                      <button
                        type="button"
                        className="elves-convert-prose"
                        data-testid="convert-to-note"
                        title="Switch to note"
                        aria-label="Switch to note"
                        onPointerDown={stopEventPropagation}
                        onClick={(e) => {
                          stopEventPropagation(e)
                          this.editor.updateShape<CardShape>({
                            id: shape.id, type: 'card',
                            props: proseToNoteProps(shape.props),
                          })
                        }}
                      >
                        <ArrowsLeftRightIcon />
                      </button>
                    )}
                  </div>
                )}
                {/* Zoomed out, hide the label/merged chrome so the gist owns the
                    whole card and reads at a glance. Both note and prose cards
                    carry a small-caps label. */}
                {!showGist && (kind === 'note' || kind === 'prose') && (
                  <div className="elves-badge-row">
                    <span className="elves-badge" data-testid="card-badge">{kind === 'prose' ? 'Prose' : 'Note'}</span>
                  </div>
                )}
                {isEditing ? (
                  <textarea
                    className="elves-card__editor"
                    autoFocus
                    defaultValue={text}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const value = e.currentTarget.value
                      this.editor.updateShape<CardShape>({
                        id: shape.id,
                        type: 'card',
                        props: {
                          text: value,
                          authoredBy: null,
                          attribution: reattribute(shape.props.text, value, shape.props.attribution, USER_AUTHOR),
                        },
                      })
                    }}
                  />
                ) : showGist ? (
                  <div
                    className="elves-card__text elves-card__text--gist"
                    data-testid="card-gist"
                    style={{
                      fontSize: fittedGistFontSize(
                        this.editor,
                        cardGist(shape.props),
                        shape.props.w,
                        shape.props.h,
                        gistFontSize(zoom),
                      ),
                    }}
                  >
                    {cardGist(shape.props)}
                  </div>
                ) : (
                  <div
                    className={`elves-card__text${blameActive ? ' elves-blame-active' : ''}`}
                    data-testid="card-text"
                  >
                    <BlameText text={text} attribution={shape.props.attribution} />
                  </div>
                )}
              </>
            )}
          </div>
          {/* Comments keep their full-size box at every zoom, including type
              label and resolve button — zoomed out past the gist threshold,
              only the BODY swaps to the comment's own model gist (same
              treatment the card's own text gets just above), sized up with
              gistFontSize so it stays legible. */}
          {comments.length > 0 && (
            <div className="elves-comments" onPointerDown={(e) => e.stopPropagation()}>
              {comments.map((c, index) => (
                <div
                  key={c.id}
                  className="elves-comment"
                  data-type={c.type ?? 'freeform'}
                >
                  <div className="elves-comment__body">
                    {c.type && <span className="elves-comment__type">{c.type}</span>}
                    <span
                      className="elves-comment__text"
                      style={showGist ? { fontSize: gistFontSize(zoom) } : undefined}
                    >
                      {showGist ? commentGist(c) : c.text}
                    </span>
                  </div>
                  <button
                    className="elves-comment__resolve"
                    data-testid="comment-resolve"
                    title="Resolve"
                    aria-label={`Resolve comment ${index + 1} of ${comments.length} on card ${cardNumber} of ${pageCards.length}: ${mechanicalGist(c.text, 80) || 'empty text'}`}
                    onClick={() =>
                      this.editor.updateShape<CardShape>({
                        id: shape.id, type: 'card',
                        props: { comments: resolveComment(shape.props.comments, c.id) },
                      })
                    }
                  >
                    <span aria-hidden="true">×</span>
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
                  <button
                    type="button"
                    className="elves-merge-fan__delete"
                    data-testid="delete-merged-card"
                    title="Delete this merged card"
                    aria-label="Delete this merged card"
                    onPointerDown={stopEventPropagation}
                    onClick={(e) => {
                      stopEventPropagation(e)
                      this.editor.deleteShape(m.id)
                    }}
                  >
                    <TrashIcon />
                  </button>
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
      ? measuredReferenceHeight(this.editor, shape.props.reference, shape.props.text, w)
      : measuredCardHeight(
          this.editor, shape.props.text, w,
          shape.props.kind === 'note' || shape.props.kind === 'prose',
          shape.props.kind === 'prose' ? PROSE_TEXT_MIN : 0,
        )
    return { ...next, props: { ...next.props, h } }
  }
}
