import type { Editor } from 'tldraw'
import { visibleComments } from '../model/comments'
import {
  compileDraft,
  type DraftBlock,
  type DraftCardInput,
  type DraftSectionInput,
} from '../model/draft'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { SectionShape } from '../shapes/SectionShapeUtil'

/** Compile the live tldraw page through the same page-space model used by the draft UI. */
export function compileEditorDraft(editor: Editor): DraftBlock[] {
  const cards: DraftCardInput[] = []
  const sections: DraftSectionInput[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) continue
    if (shape.type === 'card') {
      const props = (shape as CardShape).props
      cards.push({
        id: shape.id,
        kind: props.kind,
        noteKind: props.noteKind,
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h,
        text: props.text,
        assetId: props.assetId,
        figureTitle: props.figureTitle,
        figureStatus: props.figureStatus,
        mergedInto: props.mergedInto,
        draftExcluded: props.draftExcluded,
        unresolvedComments: visibleComments(props.comments).length,
      })
    } else if (shape.type === 'section') {
      const props = (shape as SectionShape).props
      sections.push({ id: shape.id, x: bounds.x, text: props.text, authoredBy: props.authoredBy })
    }
  }
  return compileDraft(cards, sections)
}
