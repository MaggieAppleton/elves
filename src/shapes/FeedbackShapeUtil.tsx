import { ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, stopEventPropagation, type Geometry2d } from 'tldraw'
import { makeFeedbackProps } from '../model/feedback'
import { annotationDisplayMode, feedbackAnnotationMarker } from '../model/annotations'
import { requestAnnotationOpen } from '../client/annotationSelection'
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
    const marker = feedbackAnnotationMarker(shape.props)
    if (!marker) return null
    const mode = annotationDisplayMode(this.editor.getZoomLevel())
    return (
      <HTMLContainer style={{ overflow: 'visible' }}>
        <button
          type="button"
          className="elves-annotation-marker elves-feedback-marker"
          data-mode={mode}
          data-type={marker.type ?? 'freeform'}
          data-testid="annotation-marker"
          aria-label={`Open ${marker.count} annotation${marker.count === 1 ? '' : 's'}: ${marker.label}`}
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event)
            requestAnnotationOpen({ kind: 'feedback', feedbackId: shape.id })
          }}
        >
          <span className="elves-annotation-marker__type">{marker.type ?? 'feedback'}</span>
          {mode === 'detail' && <span className="elves-annotation-marker__label">{marker.label}</span>}
          {mode === 'overview' && <span className="elves-annotation-marker__count">{marker.count}</span>}
        </button>
      </HTMLContainer>
    )
  }
  indicator(shape: FeedbackShape) { return <rect width={shape.props.w} height={shape.props.h} rx={8} /> }
  override canResize() { return false }
  override canEdit() { return false }
}
