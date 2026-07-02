import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  resizeBox,
  type Geometry2d, type TLResizeInfo,
} from 'tldraw'
import type { SectionAuthor } from '../model/sections'
import { makeSectionProps } from '../model/sections'
import './section.css'

export type SectionShape = TLBaseShape<'section', {
  w: number
  h: number
  text: string
  authoredBy: SectionAuthor
}>

export class SectionShapeUtil extends ShapeUtil<SectionShape> {
  static override type = 'section' as const
  static override props: RecordProps<SectionShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
    authoredBy: T.literalEnum('user', 'claude'),
  }

  getDefaultProps(): SectionShape['props'] {
    return makeSectionProps()
  }

  getGeometry(shape: SectionShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: SectionShape) {
    const { text, authoredBy } = shape.props
    const isEditing = this.editor.getEditingShapeId() === shape.id
    return (
      <HTMLContainer style={{ overflow: 'visible' }}>
        <div
          className="elves-section"
          data-authored-by={authoredBy}
          style={{ width: '100%', height: '100%' }}
        >
          {isEditing ? (
            <textarea
              className="elves-section__editor"
              autoFocus
              defaultValue={text}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                this.editor.updateShape<SectionShape>({
                  id: shape.id,
                  type: 'section',
                  props: { text: e.currentTarget.value, authoredBy: 'user' },
                })
              }
            />
          ) : (
            <div className="elves-section__text" data-testid="section-text">{text}</div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: SectionShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }

  override canResize() { return true }
  override canEdit() { return true }
  override onResize(shape: SectionShape, info: TLResizeInfo<SectionShape>) {
    return resizeBox(shape, info)
  }
}
