import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds, resizeBox,
  type Editor, type Geometry2d, type TLResizeInfo,
} from 'tldraw'
import { useLayoutEffect, type ReactNode } from 'react'
import type { CardKind, SourceKind, Origin, Comment } from '../model/types'
import { makeProseCardProps } from '../model/cards'
import { visibleComments, resolveComment } from '../model/comments'
import { assetUrl } from '../client/assets'
import { measuredCardHeight } from './autosize'
import './card.css'

export type CardShape = TLBaseShape<'card', {
  w: number
  h: number
  kind: CardKind
  sourceKind: SourceKind | null
  origin: Origin | null
  text: string
  comments: Comment[]
  mergedInto: string | null
  assetId: string | null
}>

export function addCommentsUp(props: Record<string, unknown>): void {
  props.comments = []
  props.mergedInto = null
}

export function addAssetIdUp(props: Record<string, unknown>): void {
  props.assetId = null
}

const cardVersions = createShapePropsMigrationIds('card', { AddComments: 1, AddAssetId: 2 })

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
  const { text, w, h, kind, sourceKind } = shape.props
  useLayoutEffect(() => {
    let cancelled = false
    const fit = () => {
      if (cancelled) return
      const cur = editor.getShape<CardShape>(shape.id)
      if (!cur || cur.props.mergedInto || cur.props.sourceKind === 'image') return
      const want = measuredCardHeight(editor, cur.props.text, cur.props.w, cur.props.kind === 'source')
      if (Math.abs(want - cur.props.h) > 1) {
        editor.updateShape<CardShape>({ id: cur.id, type: 'card', props: { h: want } })
      }
    }
    fit()
    document.fonts?.ready?.then(fit)
    return () => { cancelled = true }
  }, [editor, shape.id, text, w, h, kind, sourceKind])
  return <>{children}</>
}

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const
  static override migrations = cardMigrations
  static override props: RecordProps<CardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('source', 'prose'),
    sourceKind: T.nullable(T.literalEnum('text', 'image')),
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed', 'transcribed')),
    text: T.string,
    comments: T.arrayOf(
      T.object({
        id: T.string,
        type: T.nullable(T.literalEnum('needs-evidence', 'weak-argument', 'needs-citation')),
        text: T.string,
        resolved: T.boolean,
        author: T.literalEnum('claude'),
      }),
    ),
    mergedInto: T.nullable(T.string),
    assetId: T.nullable(T.string),
  }

  getDefaultProps(): CardShape['props'] {
    // Delegate to the unit-tested model factory so defaults stay DRY.
    return makeProseCardProps()
  }

  getGeometry(shape: CardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: CardShape) {
    if (shape.props.mergedInto) {
      // Merged into a representative — hidden but recoverable.
      return <HTMLContainer />
    }
    const mergedCount = this.editor
      .getCurrentPageShapes()
      .filter((s) => s.type === 'card' && (s as CardShape).props.mergedInto === shape.id).length
    const { kind, text, sourceKind, assetId } = shape.props
    const isImage = sourceKind === 'image' && !!assetId
    const isEditing = this.editor.getEditingShapeId() === shape.id
    const comments = visibleComments(shape.props.comments)
    return (
      <AutosizeCard editor={this.editor} shape={shape}>
      <HTMLContainer style={{ overflow: 'visible' }}>
        <div className="elves-card-wrap" style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div
            className={`elves-card elves-card--${kind}${isImage ? ' elves-card--image' : ''}`}
            style={{ width: '100%', height: '100%' }}
          >
            {sourceKind === 'image' && assetId ? (
              // Image cards are just the image — edge-to-edge, no label, no chrome.
              <img
                className="elves-card__image"
                src={assetUrl(assetId)}
                alt=""
                draggable={false}
                data-testid="card-image"
              />
            ) : (
              <>
                {kind === 'source' && (
                  <span className="elves-badge" data-testid="card-badge">Note</span>
                )}
                {mergedCount > 0 && (
                  <span className="elves-merged" data-testid="merged-badge">⊕ {mergedCount} merged</span>
                )}
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
                ) : (
                  <div className="elves-card__text" data-testid="card-text">{text}</div>
                )}
              </>
            )}
          </div>
          {comments.length > 0 && (
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
  override onResize(shape: CardShape, info: TLResizeInfo<CardShape>) {
    // Let the user set the width by dragging; height always fits the text at
    // that width, so a resize can't clip content or leave dead space.
    const next = resizeBox(shape, info)
    if (shape.props.sourceKind === 'image') return next
    const w = next.props?.w ?? shape.props.w
    const h = measuredCardHeight(this.editor, shape.props.text, w, shape.props.kind === 'source')
    return { ...next, props: { ...next.props, h } }
  }
}
