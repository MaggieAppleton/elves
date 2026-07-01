import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds,
  type Geometry2d,
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
}>

export function addCommentsUp(props: Record<string, unknown>): void {
  props.comments = []
  props.mergedInto = null
}

const cardVersions = createShapePropsMigrationIds('card', { AddComments: 1 })

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
  }

  getDefaultProps(): CardShape['props'] {
    // Delegate to the unit-tested model factory so defaults stay DRY.
    return makeProseCardProps()
  }

  getGeometry(shape: CardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: CardShape) {
    const { kind, origin, text } = shape.props
    const isEditing = this.editor.getEditingShapeId() === shape.id
    const comments = visibleComments(shape.props.comments)
    return (
      <HTMLContainer>
        <div className={`elves-card elves-card--${kind}`} style={{ width: '100%', height: '100%' }}>
          {kind === 'source' && (
            <span className="elves-badge" data-testid="card-badge">{origin ?? 'source'}</span>
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
          {comments.length > 0 && (
            <div className="elves-comments">
              {comments.map((c) => (
                <div
                  key={c.id}
                  className="elves-comment"
                  data-type={c.type ?? 'freeform'}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {c.type && <span className="elves-comment__type">{c.type}</span>}
                  <span className="elves-comment__text">{c.text}</span>
                  <button
                    className="elves-comment__resolve"
                    data-testid="comment-resolve"
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
}
