import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  stopEventPropagation, createShapePropsMigrationSequence, createShapePropsMigrationIds,
  type Editor, type Geometry2d,
} from 'tldraw'
import { useLayoutEffect, type ReactNode } from 'react'
import { makeQuestionProps } from '../model/questions'
import { measuredQuestionHeight, fittedQuestionGistFontSize } from './autosize'
import { agentInfo } from './agents'
import { commentGist } from '../model/summary'
import { shouldShowQuestionGist, gistFontSize } from './summaryView'
import './question.css'

export type QuestionShape = TLBaseShape<'question', {
  w: number
  h: number
  text: string
  authoredBy: string
  dismissed: boolean
  summary: string | null
  summaryOfHash: string | null
  summaryBy: string | null
  summaryAt: string | null
}>

// Questions predate their summary fields; default them to "no summary yet" so
// reconciliation treats an old question exactly like a freshly-created one.
export function addQuestionSummaryUp(props: Record<string, unknown>): void {
  props.summary = null
  props.summaryOfHash = null
  props.summaryBy = null
  props.summaryAt = null
}

// The inverse of addQuestionSummaryUp: strips the four summary fields back
// off, restoring a pre-summary question shape.
export function removeQuestionSummaryDown(props: Record<string, unknown>): void {
  delete props.summary
  delete props.summaryOfHash
  delete props.summaryBy
  delete props.summaryAt
}

const questionVersions = createShapePropsMigrationIds('question', { AddSummary: 1 })

export const questionMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: questionVersions.AddSummary,
      up: (props) => addQuestionSummaryUp(props as Record<string, unknown>),
      down: (props) => removeQuestionSummaryDown(props as Record<string, unknown>),
    },
  ],
})

/**
 * Keeps a question's height fitted to its text (its width is fixed — a small
 * sticky note). Mirrors AutosizeSection, re-fitting once web fonts are ready so
 * the first measure (possibly before Inter loads) doesn't leave the box wrong.
 */
function AutosizeQuestion({
  editor, shape, children,
}: { editor: Editor; shape: QuestionShape; children: ReactNode }) {
  const { text, w, h } = shape.props
  useLayoutEffect(() => {
    let cancelled = false
    const fit = () => {
      if (cancelled) return
      const cur = editor.getShape<QuestionShape>(shape.id)
      if (!cur) return
      const wantH = measuredQuestionHeight(editor, cur.props.text, cur.props.w)
      if (Math.abs(wantH - cur.props.h) > 1) {
        editor.updateShape<QuestionShape>({ id: cur.id, type: 'question', props: { h: wantH } })
      }
    }
    fit()
    document.fonts?.ready?.then(fit)
    return () => { cancelled = true }
  }, [editor, shape.id, text, w, h])
  return <>{children}</>
}

export class QuestionShapeUtil extends ShapeUtil<QuestionShape> {
  static override type = 'question' as const
  static override props: RecordProps<QuestionShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
    authoredBy: T.string,
    dismissed: T.boolean,
    summary: T.nullable(T.string),
    summaryOfHash: T.nullable(T.string),
    summaryBy: T.nullable(T.string),
    summaryAt: T.nullable(T.string),
  }

  static override migrations = questionMigrations

  getDefaultProps(): QuestionShape['props'] {
    return makeQuestionProps()
  }

  getGeometry(shape: QuestionShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: QuestionShape) {
    const { text, authoredBy } = shape.props
    // Whoever asked it — drives the accent and the small authorship logomark.
    // Unknown ids fall back to the Claude accent so a question is never colourless.
    const agent = agentInfo(authoredBy)
    const accent = agent?.accent ?? 'var(--elves-claude-accent)'
    // Zoomed far out, a summarized question shows its gist so it reads at a
    // glance alongside gisted cards. getZoomLevel is reactive, so this
    // re-renders as the user zooms; the gist font counter-scales with zoom to
    // stay a readable on-screen size, then is fitted to the box (as cards do).
    const zoom = this.editor.getZoomLevel()
    const showGist = shouldShowQuestionGist(zoom, shape.props)
    // The dismiss ✓ is revealed on hover/selection. The shape body is
    // pointer-events:none (so clicks fall through to the canvas for dragging),
    // which means CSS :hover can't fire on it — so drive the reveal from tldraw's
    // own hover/selection state, which it derives from canvas hit-testing. Reading
    // these signals here re-renders the shape as hover/selection changes.
    const revealed =
      this.editor.getHoveredShapeId() === shape.id ||
      this.editor.getSelectedShapeIds().includes(shape.id)
    return (
      <AutosizeQuestion editor={this.editor} shape={shape}>
        <HTMLContainer style={{ overflow: 'visible' }}>
          <div
            className="elves-question"
            data-authored-by={authoredBy}
            data-testid="question"
            data-reveal={revealed ? 'true' : undefined}
            style={{ width: '100%', height: '100%', ['--q-accent' as string]: accent }}
          >
            <div className="elves-question__header">
              <span className="elves-question__glyph" aria-hidden="true">?</span>
              {agent && (
                <span
                  className="elves-question__mark"
                  data-testid="question-agent-mark"
                  data-agent={agent.id}
                  title={`Asked by ${agent.name}`}
                >
                  <agent.Logo aria-hidden="true" focusable="false" />
                </span>
              )}
              {/* Dismiss (✓): a plain user edit — an agent never dismisses. The
                  dismissed shape stays in the file (recoverable), just hidden by
                  App's getShapeVisibility. Revealed on hover (see question.css). */}
              <button
                type="button"
                className="elves-question__dismiss"
                data-testid="question-dismiss"
                title="Dismiss — I've answered this (or it's not useful)"
                aria-label={`Dismiss question: ${shape.props.text}`}
                onPointerDown={stopEventPropagation}
                onClick={(e) => {
                  stopEventPropagation(e)
                  this.editor.updateShape<QuestionShape>({
                    id: shape.id, type: 'question', props: { dismissed: true },
                  })
                }}
              >
                <span aria-hidden="true">✓</span>
              </button>
            </div>
            <div
              className="elves-question__text"
              data-testid="question-text"
              data-gist={showGist ? 'true' : undefined}
              style={
                showGist
                  ? {
                      fontSize: fittedQuestionGistFontSize(
                        this.editor,
                        commentGist(shape.props),
                        shape.props.w,
                        shape.props.h,
                        gistFontSize(zoom),
                      ),
                    }
                  : undefined
              }
            >
              {showGist ? commentGist(shape.props) : text}
            </div>
          </div>
        </HTMLContainer>
      </AutosizeQuestion>
    )
  }

  indicator(shape: QuestionShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }

  // The user moves questions freely, but never resizes or edits their text (the
  // words are the agent's — answering by editing would blur provenance).
  override canResize() { return false }
  override canEdit() { return false }
}
