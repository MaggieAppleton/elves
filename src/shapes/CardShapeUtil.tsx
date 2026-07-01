import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds, resizeBox,
  type Geometry2d, type TLResizeInfo,
} from 'tldraw'
import type { CardKind, SourceKind, Origin, Comment } from '../model/types'
import { makeProseCardProps } from '../model/cards'
import { visibleComments, resolveComment } from '../model/comments'
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

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const
  static override migrations = cardMigrations
  static override props: RecordProps<CardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('source', 'prose'),
    sourceKind: T.nullable(T.literalEnum('text', 'image')),
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed')),
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
    const { kind, origin, text } = shape.props
    const isEditing = this.editor.getEditingShapeId() === shape.id
    const comments = visibleComments(shape.props.comments)
    return (
      <HTMLContainer style={{ overflow: 'visible' }}>
        <div className="elves-card-wrap" style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div className={`elves-card elves-card--${kind}`} style={{ width: '100%', height: '100%' }}>
            {kind === 'source' && (
              <span className="elves-badge" data-testid="card-badge">{origin ?? 'source'}</span>
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
    )
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} />
  }

  override canResize() { return true }
  override canEdit() { return true }
  override onResize(shape: CardShape, info: TLResizeInfo<CardShape>) {
    return resizeBox(shape, info)
  }
}
