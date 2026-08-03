import { ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, stopEventPropagation, type Editor, type Geometry2d } from 'tldraw'
import { useLayoutEffect, type ReactNode } from 'react'
import { makeFeedbackProps } from '../model/feedback'
import { measuredFeedbackHeight } from './autosize'
import { agentInfo } from './agents'
import './feedback.css'

export type FeedbackShape = TLBaseShape<'feedback', ReturnType<typeof makeFeedbackProps>>

function AutosizeFeedback({
  editor, shape, children,
}: { editor: Editor; shape: FeedbackShape; children: ReactNode }) {
  const { text, w, h } = shape.props
  useLayoutEffect(() => {
    let cancelled = false
    const fit = () => {
      if (cancelled) return
      const current = editor.getShape<FeedbackShape>(shape.id)
      if (!current) return
      const height = measuredFeedbackHeight(editor, current.props.text, current.props.w)
      if (Math.abs(height - current.props.h) > 1) {
        editor.run(() => {
          editor.updateShape<FeedbackShape>({
            id: current.id,
            type: 'feedback',
            props: { h: height },
          })
        }, { history: 'ignore' })
      }
    }
    fit()
    document.fonts?.ready?.then(fit)
    return () => { cancelled = true }
  }, [editor, shape.id, text, w, h])
  return <>{children}</>
}

export class FeedbackShapeUtil extends ShapeUtil<FeedbackShape> {
  static override type = 'feedback' as const
  static override props = {
    w: T.number, h: T.number, text: T.string, authoredBy: T.string,
    type: T.nullable(T.string), reviewId: T.nullable(T.string), reviewer: T.nullable(T.string), resolved: T.boolean,
  }
  getDefaultProps(): FeedbackShape['props'] { return makeFeedbackProps() }
  getGeometry(shape: FeedbackShape): Geometry2d { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }) }
  component(shape: FeedbackShape) {
    const agent = agentInfo(shape.props.authoredBy)
    const reviewer = shape.props.reviewer ? shape.props.reviewer.replaceAll('-', ' ') : null
    return <AutosizeFeedback editor={this.editor} shape={shape}>
      <HTMLContainer style={{ overflow: 'visible' }}>
        <div className="elves-feedback" data-resolved={shape.props.resolved || undefined} style={{ width: '100%', height: '100%' }}>
          <div className="elves-feedback__meta"><span>{reviewer ?? 'Agent feedback'}{agent && reviewer ? ` · ${agent.name}` : !reviewer ? ` · ${agent?.name ?? shape.props.authoredBy}` : ''}</span>{shape.props.type && <span>{shape.props.type.replaceAll('-', ' ')}</span>}<button type="button" className="elves-feedback__resolve" aria-label="Resolve feedback" onPointerDown={stopEventPropagation} onClick={(event) => { stopEventPropagation(event); this.editor.updateShape<FeedbackShape>({ id: shape.id, type: 'feedback', props: { resolved: true } }) }}>✓</button></div>
          <div className="elves-feedback__text">{shape.props.text}</div>
        </div>
      </HTMLContainer>
    </AutosizeFeedback>
  }
  indicator(shape: FeedbackShape) { return <rect width={shape.props.w} height={shape.props.h} rx={8} /> }
  override canResize() { return false }
  override canEdit() { return false }
}
