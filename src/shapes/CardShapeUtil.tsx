import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  type Geometry2d,
} from 'tldraw'
import type { CardKind, SourceKind, Origin } from '../model/types'
import { makeProseCardProps } from '../model/cards'
import './card.css'

export type CardShape = TLBaseShape<'card', {
  w: number
  h: number
  kind: CardKind
  sourceKind: SourceKind | null
  origin: Origin | null
  text: string
}>

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const
  static override props: RecordProps<CardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('source', 'prose'),
    sourceKind: T.nullable(T.literalEnum('text', 'image')),
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed')),
    text: T.string,
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
