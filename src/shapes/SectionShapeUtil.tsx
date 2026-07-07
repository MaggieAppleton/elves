import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  resizeBox,
  type Editor, type Geometry2d, type TLResizeInfo, type TLShapePartial,
} from 'tldraw'
import { useLayoutEffect, type ReactNode } from 'react'
import type { SectionAuthor } from '../model/sections'
import { makeSectionProps, SECTION_DEFAULT_W } from '../model/sections'
import { measuredSectionSize } from './autosize'
import './section.css'

export type SectionShape = TLBaseShape<'section', {
  w: number
  h: number
  text: string
  authoredBy: SectionAuthor
}>

/**
 * Sizes a section header to its label: a header still at the default width is
 * fitted to about two lines (never the three-line overflow that clipped the big
 * 56px labels), and height always follows the text. A header the user has
 * widened keeps its width — only its height is kept in sync.
 */
function AutosizeSection({
  editor, shape, children,
}: { editor: Editor; shape: SectionShape; children: ReactNode }) {
  const { text, w, h } = shape.props
  useLayoutEffect(() => {
    let cancelled = false
    const fit = () => {
      if (cancelled) return
      const cur = editor.getShape<SectionShape>(shape.id)
      if (!cur) return
      const fitWidth = Math.abs(cur.props.w - SECTION_DEFAULT_W) < 1
      const size = measuredSectionSize(editor, cur.props.text, cur.props.w, fitWidth)
      const props: Partial<SectionShape['props']> = {}
      if (Math.abs(size.w - cur.props.w) > 1) props.w = size.w
      if (Math.abs(size.h - cur.props.h) > 1) props.h = size.h
      if (props.w !== undefined || props.h !== undefined) {
        editor.updateShape<SectionShape>({ id: cur.id, type: 'section', props })
      }
    }
    fit()
    document.fonts?.ready?.then(fit)
    return () => { cancelled = true }
  }, [editor, shape.id, text, w, h])
  return <>{children}</>
}

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
      <AutosizeSection editor={this.editor} shape={shape}>
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
      </AutosizeSection>
    )
  }

  indicator(shape: SectionShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }

  override canResize() { return true }
  override canEdit() { return true }
  // See CardShapeUtil's onRotate for why: resolvePageXY (server/digest.ts)
  // assumes no ancestor is rotated, and tldraw has no canRotate() flag. Hiding
  // the handle blocks drag-rotate; vetoing onRotate blocks the rotate-90
  // actions too, since they bypass hideRotateHandle. Issue #39.
  override hideRotateHandle() { return true }
  override onRotate(initial: SectionShape): TLShapePartial<SectionShape> {
    return { id: initial.id, type: 'section', x: initial.x, y: initial.y, rotation: initial.rotation }
  }
  override onResize(shape: SectionShape, info: TLResizeInfo<SectionShape>) {
    // User drags the width; height re-fits the label at that width.
    const next = resizeBox(shape, info)
    const w = next.props?.w ?? shape.props.w
    const h = measuredSectionSize(this.editor, shape.props.text, w, false).h
    return { ...next, props: { ...next.props, h } }
  }
}
