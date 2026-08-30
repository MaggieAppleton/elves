import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T,
  createShapePropsMigrationIds, createShapePropsMigrationSequence,
  type Geometry2d,
} from 'tldraw'
import { FEEDBACK_DEFAULT_H, FEEDBACK_DEFAULT_W, makeFeedbackProps } from '../model/feedback'
import { AnnotationPin } from '../components/AnnotationThread'
import { requestAnnotationOpen } from '../client/annotationSelection'
import './feedback.css'

export type FeedbackShape = TLBaseShape<'feedback', ReturnType<typeof makeFeedbackProps>>

const LEGACY_FEEDBACK_W = 370
const LEGACY_FEEDBACK_H = 96

/** Existing feedback was stored as a card-sized shape. Its saved x/y stays
 * untouched; only its hit-test rectangle changes to match the compact pin. */
export function compactFeedbackPinUp(props: Record<string, unknown>): void {
  props.w = FEEDBACK_DEFAULT_W
  props.h = FEEDBACK_DEFAULT_H
}

export function compactFeedbackPinDown(props: Record<string, unknown>): void {
  if (props.w === FEEDBACK_DEFAULT_W && props.h === FEEDBACK_DEFAULT_H) {
    props.w = LEGACY_FEEDBACK_W
    props.h = LEGACY_FEEDBACK_H
  }
}

const feedbackVersions = createShapePropsMigrationIds('feedback', { CompactPin: 1 })
export const feedbackMigrations = createShapePropsMigrationSequence({
  sequence: [{
    id: feedbackVersions.CompactPin,
    up: (props) => compactFeedbackPinUp(props as Record<string, unknown>),
    down: (props) => compactFeedbackPinDown(props as Record<string, unknown>),
  }],
})

export class FeedbackShapeUtil extends ShapeUtil<FeedbackShape> {
  static override type = 'feedback' as const
  static override migrations = feedbackMigrations
  static override props = {
    w: T.number, h: T.number, text: T.string, authoredBy: T.string,
    type: T.nullable(T.string), reviewId: T.nullable(T.string), reviewer: T.nullable(T.string), resolved: T.boolean,
    messages: T.arrayOf(T.object({ id: T.string, author: T.string, text: T.string, createdAt: T.string, inReplyToMessageId: T.string.optional() })).optional(),
  }
  getDefaultProps(): FeedbackShape['props'] { return makeFeedbackProps() }
  getGeometry(shape: FeedbackShape): Geometry2d { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }) }
  component(shape: FeedbackShape) {
    if (shape.props.resolved) return null
    return (
      <HTMLContainer style={{ overflow: 'visible' }}>
        <AnnotationPin
          className="elves-feedback-pin"
          comment={{ id: shape.id, type: shape.props.type, text: shape.props.text, resolved: false, author: shape.props.authoredBy, messages: shape.props.messages }}
          zoom={this.editor.getZoomLevel()}
          target={{ kind: 'feedback', feedbackId: shape.id }}
          onOpen={() => requestAnnotationOpen({ kind: 'feedback', feedbackId: shape.id })}
        />
      </HTMLContainer>
    )
  }
  indicator(shape: FeedbackShape) { return <rect width={shape.props.w} height={shape.props.h} rx={8} /> }
  override canResize() { return false }
  override canEdit() { return false }
}
