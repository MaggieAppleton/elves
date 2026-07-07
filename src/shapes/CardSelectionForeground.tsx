import { TldrawSelectionForeground, useEditor, useValue } from 'tldraw'
import type { ComponentProps } from 'react'
import type { CardShape } from './CardShapeUtil'
import './card.css'

// CardShapeUtil.onResize always recomputes height to fit the text/figure/
// reference content, so a manual vertical (or corner) drag is discarded on
// the next render — the handle looks interactive but nothing sticks. Width
// is the only dimension that's genuinely user-controlled for those cards.
// Image cards are the exception: they resize freely in both dimensions.
//
// tldraw's ShapeUtil API only exposes all-or-nothing resize toggles
// (`canResize`/`hideResizeHandles`), not per-edge control, so we override
// the `SelectionForeground` component (a documented extension point, see
// `TLComponents` in @tldraw/editor) to tag the selection overlay with a
// class when the only selected shape is a non-image card, and use CSS to
// hide the vertical/corner resize handles for that case.
export function CardSelectionForeground(
  props: ComponentProps<typeof TldrawSelectionForeground>,
) {
  const editor = useEditor()
  const horizontalOnly = useValue(
    'card resize is horizontal-only',
    () => {
      const shape = editor.getOnlySelectedShape()
      return !!shape && shape.type === 'card' && (shape as CardShape).props.noteKind !== 'image'
    },
    [editor],
  )
  return (
    <div className={horizontalOnly ? 'elves-selection-fg--h-only' : undefined}>
      <TldrawSelectionForeground {...props} />
    </div>
  )
}
