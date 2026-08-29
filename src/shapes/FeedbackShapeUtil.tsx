import { ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, type Geometry2d } from 'tldraw'
import { makeFeedbackProps } from '../model/feedback'
import { AnnotationPin } from '../components/AnnotationThread'
import { requestAnnotationOpen, requestAnnotationReply } from '../client/annotationSelection'
import './feedback.css'

export type FeedbackShape = TLBaseShape<'feedback', ReturnType<typeof makeFeedbackProps>>

export class FeedbackShapeUtil extends ShapeUtil<FeedbackShape> {
  static override type = 'feedback' as const
  static override props = {
    w: T.number, h: T.number, text: T.string, authoredBy: T.string,
    type: T.nullable(T.string), reviewId: T.nullable(T.string), reviewer: T.nullable(T.string), resolved: T.boolean,
  }
  getDefaultProps(): FeedbackShape['props'] { return makeFeedbackProps() }
  getGeometry(shape: FeedbackShape): Geometry2d { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }) }
  component(shape: FeedbackShape) {
    if (shape.props.resolved) return null
    return (
      <HTMLContainer style={{ overflow: 'visible' }}>
        <AnnotationPin
          className="elves-feedback-pin"
          comment={{ id: shape.id, type: shape.props.type, text: shape.props.text, resolved: false, author: shape.props.authoredBy }}
          zoom={this.editor.getZoomLevel()}
          attribution={shape.props.reviewer?.replaceAll('-', ' ')}
          target={{ kind: 'feedback', feedbackId: shape.id }}
          onOpen={() => requestAnnotationOpen({ kind: 'feedback', feedbackId: shape.id })}
          onReply={requestAnnotationReply}
        />
      </HTMLContainer>
    )
  }
  indicator(shape: FeedbackShape) { return <rect width={shape.props.w} height={shape.props.h} rx={8} /> }
  override canResize() { return false }
  override canEdit() { return false }
}
