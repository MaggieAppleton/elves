import { Editor, createShapeId, TLShapeId } from 'tldraw'
import { CHANGE_SET_STAMP_META_KEY, ChangeSet, Op, planMerge } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { SectionShape } from '../shapes/SectionShapeUtil'
import { QuestionShape } from '../shapes/QuestionShapeUtil'
import { makeComment, addComment, estimateCommentHeight } from '../model/comments'
import { makeNoteCardProps, makeReferenceCardProps, makeFigureCardProps, claudeMayEditCardText } from '../model/cards'
import { reattribute } from '../model/attribution'
import { makeSectionProps } from '../model/sections'
import { makeQuestionProps } from '../model/questions'
import { canvasObstacles, clearCardPosition, reflowCardLane } from '../client/canvasLayout'
import { placeBelowObstacles } from '../model/layout'

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

// Each applyX returns the shape ids it TOUCHED — "what the user should see the
// agent just did here" — so applyChangeSet can drive the ephemeral presence glow
// (see src/client/presence.ts). Ids of cards created in the change-set are minted
// locally below, so this return value is the only place they surface.

function applyAddComment(
  editor: Editor,
  op: Extract<Op, { kind: 'add_comment' }>,
  author: string,
): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return []
  const comment = makeComment(
    newId('cmt'), op.comment.text, op.comment.type, author, op.comment.reviewId ?? null,
  )
  const previousHeight = shape.props.h + (shape.props.commentH ?? 0)
  const comments = addComment(shape.props.comments, comment)
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: {
      comments,
      commentH: estimateCommentHeight(comments, shape.props.w),
    },
  })
  return [shape.id, ...reflowCardLane(editor, shape.id, previousHeight)]
}

function applyMerge(editor: Editor, op: Extract<Op, { kind: 'merge_notes' }>): TLShapeId[] {
  const { representativeId, hiddenIds } = planMerge(op.cardIds)
  // The representative becomes the visible head of the merge cluster, so it
  // must be a note itself — the server's changeset endpoint already rejects
  // this case with a 409, but guard here too so this function never merges
  // under a non-note representative if ever applied directly.
  const rep = editor.getShape(representativeId as CardShape['id']) as CardShape | undefined
  if (!rep || rep.props.kind !== 'note') return []
  for (const id of hiddenIds) {
    const shape = editor.getShape(id as CardShape['id']) as CardShape | undefined
    if (shape && shape.props.kind === 'note') {
      editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { mergedInto: representativeId } })
    }
  }
  // Glow the visible survivor — the hidden members are removed from render.
  return [representativeId as TLShapeId]
}

function applyMove(editor: Editor, op: Extract<Op, { kind: 'move_cards' }>): TLShapeId[] {
  const moved: TLShapeId[] = []
  const movingIds = new Set(
    op.moves
      .map((move) => editor.getShape(move.cardId as CardShape['id']))
      .filter((shape): shape is CardShape => shape?.type === 'card')
      .map((shape) => shape.id),
  )
  const obstacles = canvasObstacles(editor, movingIds)
  for (const m of op.moves) {
    const shape = editor.getShape(m.cardId as CardShape['id']) as CardShape | undefined
    if (!shape) continue
    const placed = placeBelowObstacles(
      { x: m.x, y: m.y, w: shape.props.w, h: shape.props.h },
      obstacles,
    )
    // The agent passes absolute page coords; updateShape expects parent-local coords.
    // getPointInParentSpace is identity for top-level cards, and converts for grouped ones.
    const local = editor.getPointInParentSpace(shape.id, { x: placed.x, y: placed.y })
    editor.updateShape({ id: shape.id, type: 'card', x: local.x, y: local.y })
    moved.push(shape.id)
    obstacles.push(placed)
  }
  return moved
}

function applyCreateNoteCard(
  editor: Editor,
  op: Extract<Op, { kind: 'create_note_card' }>,
  author: string,
  acceptedTokenStamp?: string,
): TLShapeId[] {
  // Stamp the change-set's author onto the card so its authorship mark shows.
  const props = makeNoteCardProps(op.text, 'transcribed', author)
  const at = clearCardPosition(editor, { x: op.x, y: op.y, w: props.w, h: props.h })
  const id = createShapeId()
  editor.createShape<CardShape>({
    id, type: 'card', x: at.x, y: at.y, props,
    meta: acceptedTokenStamp ? { [CHANGE_SET_STAMP_META_KEY]: acceptedTokenStamp } : {},
  })
  return [id]
}

function applyCreateReference(
  editor: Editor,
  op: Extract<Op, { kind: 'create_reference' }>,
  acceptedTokenStamp?: string,
): TLShapeId[] {
  const props = makeReferenceCardProps(op.reference)
  const at = clearCardPosition(editor, { x: op.x, y: op.y, w: props.w, h: props.h })
  const id = createShapeId()
  editor.createShape<CardShape>({
    id, type: 'card', x: at.x, y: at.y, props,
    meta: acceptedTokenStamp ? { [CHANGE_SET_STAMP_META_KEY]: acceptedTokenStamp } : {},
  })
  return [id]
}

function applyCreateFigureCard(
  editor: Editor,
  op: Extract<Op, { kind: 'create_figure_card' }>,
  author: string,
  acceptedTokenStamp?: string,
): TLShapeId[] {
  // Stamp the change-set's author onto the figure so an agent-suggested one
  // carries its authorship mark ("its suggestion, my call").
  const props = makeFigureCardProps(op.title, op.description, author)
  const at = clearCardPosition(editor, { x: op.x, y: op.y, w: props.w, h: props.h })
  const id = createShapeId()
  editor.createShape<CardShape>({
    id, type: 'card', x: at.x, y: at.y, props,
    meta: acceptedTokenStamp ? { [CHANGE_SET_STAMP_META_KEY]: acceptedTokenStamp } : {},
  })
  return [id]
}

function applyEditCard(editor: Editor, op: Extract<Op, { kind: 'edit_card' }>, author: string): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  // Working material (note / reference / figure) is the agent's to edit; a prose
  // card holds the user's own draft and stays the user's alone.
  // A reference's `text` is the user's own annotation — the agent writes its
  // bibliographic facts at creation, never the annotation, so references are
  // excluded here even though they're a 'note'-kind card.
  if (!shape || !claudeMayEditCardText(shape.props.kind) || shape.props.noteKind === 'reference') return []
  const props: Partial<CardShape['props']> = {}
  // `text` is the card body; `title` is a figure's working title (figures only).
  // When the body changes, credit the edited span to this change-set's author so
  // the card keeps every contributor's mark, not just the last writer.
  if (op.text !== undefined) {
    props.text = op.text
    props.attribution = reattribute(shape.props.text, op.text, shape.props.attribution, author)
  }
  if (op.title !== undefined && shape.props.kind === 'figure') props.figureTitle = op.title
  editor.updateShape<CardShape>({ id: shape.id, type: 'card', props })
  return [shape.id]
}

function applyDeleteCard(editor: Editor, op: Extract<Op, { kind: 'delete_card' }>): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  // An agent may retract only cards it authored; the user's own cards are protected.
  if (!shape || !shape.props.authoredBy) return []
  editor.deleteShape(shape.id)
  // The shape is gone, so there's nothing to glow — return nothing.
  return []
}

function applyCreateSection(
  editor: Editor,
  op: Extract<Op, { kind: 'create_section' }>,
  author: string,
  acceptedTokenStamp?: string,
): TLShapeId[] {
  const id = createShapeId()
  editor.createShape<SectionShape>({
    id,
    type: 'section',
    x: op.x,
    y: op.y,
    props: makeSectionProps(op.text, author),
    meta: acceptedTokenStamp ? { [CHANGE_SET_STAMP_META_KEY]: acceptedTokenStamp } : {},
  })
  return [id]
}

function applyMoveSections(editor: Editor, op: Extract<Op, { kind: 'move_sections' }>): TLShapeId[] {
  const moved: TLShapeId[] = []
  for (const m of op.moves) {
    const shape = editor.getShape(m.sectionId as SectionShape['id'])
    if (shape) {
      editor.updateShape({ id: shape.id, type: 'section', x: m.x, y: m.y })
      moved.push(shape.id)
    }
  }
  return moved
}

function applyEditSectionText(
  editor: Editor,
  op: Extract<Op, { kind: 'edit_section_text' }>,
  author: string,
): TLShapeId[] {
  const shape = editor.getShape(op.sectionId as SectionShape['id']) as SectionShape | undefined
  if (!shape) return []
  editor.updateShape<SectionShape>({
    id: shape.id, type: 'section',
    props: { text: op.text, authoredBy: author },
  })
  return [shape.id]
}

function applyCreateQuestion(
  editor: Editor,
  op: Extract<Op, { kind: 'create_question' }>,
  author: string,
  acceptedTokenStamp?: string,
): TLShapeId[] {
  const props = makeQuestionProps(op.text, author)
  const at = placeBelowObstacles(
    { x: op.x, y: op.y, w: props.w, h: props.h },
    canvasObstacles(editor),
  )
  const id = createShapeId()
  editor.createShape<QuestionShape>({
    id,
    type: 'question',
    x: at.x,
    y: at.y,
    props,
    meta: acceptedTokenStamp ? { [CHANGE_SET_STAMP_META_KEY]: acceptedTokenStamp } : {},
  })
  return [id]
}

function applyGroupCards(editor: Editor, op: Extract<Op, { kind: 'group_cards' }>): TLShapeId[] {
  const ids = op.cardIds
    .map((id) => editor.getShape(id as CardShape['id'])?.id)
    .filter((id): id is CardShape['id'] => !!id)
  if (ids.length >= 2) editor.groupShapes(ids)
  // Glow the members the agent bound together (the group wrapper itself is chrome).
  return ids
}

function applyUngroupCards(editor: Editor, op: Extract<Op, { kind: 'ungroup_cards' }>): TLShapeId[] {
  const group = editor.getShape(op.groupId as TLShapeId)
  if (!group) return []
  // Capture the children BEFORE ungrouping — the group wrapper is gone after, so
  // the freed cards are what the user should see light up.
  const children = editor.getSortedChildIdsForParent(group.id)
  editor.ungroupShapes([group.id])
  return [...children]
}

function applySetSummary(editor: Editor, op: Extract<Op, { kind: 'set_summary' }>): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return []
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: {
      summary: op.summary,
      summaryOfHash: op.summaryOfHash,
      summaryBy: op.summaryBy,
      summaryAt: op.summaryAt,
    },
  })
  return [shape.id]
}

function applySetCommentSummary(
  editor: Editor,
  op: Extract<Op, { kind: 'set_comment_summary' }>,
): TLShapeId[] {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return []
  const comments = shape.props.comments.map((c) =>
    c.id === op.commentId
      ? {
          ...c,
          summary: op.summary,
          summaryOfHash: op.summaryOfHash,
          summaryBy: op.summaryBy,
          summaryAt: op.summaryAt,
        }
      : c,
  )
  editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { comments } })
  return [shape.id]
}

function applySetQuestionSummary(
  editor: Editor,
  op: Extract<Op, { kind: 'set_question_summary' }>,
): TLShapeId[] {
  const shape = editor.getShape(op.questionId as QuestionShape['id']) as QuestionShape | undefined
  if (!shape) return []
  editor.updateShape<QuestionShape>({
    id: shape.id, type: 'question',
    props: {
      summary: op.summary,
      summaryOfHash: op.summaryOfHash,
      summaryBy: op.summaryBy,
      summaryAt: op.summaryAt,
    },
  })
  return [shape.id]
}

function applyOp(editor: Editor, op: Op, author: string, acceptedTokenStamp?: string): TLShapeId[] {
  switch (op.kind) {
    case 'add_comment':
      return applyAddComment(editor, op, author)
    case 'merge_notes':
      return applyMerge(editor, op)
    case 'move_cards':
      return applyMove(editor, op)
    case 'create_note_card':
      return applyCreateNoteCard(editor, op, author, acceptedTokenStamp)
    case 'create_reference':
      return applyCreateReference(editor, op, acceptedTokenStamp)
    case 'create_figure_card':
      return applyCreateFigureCard(editor, op, author, acceptedTokenStamp)
    case 'edit_card':
      return applyEditCard(editor, op, author)
    case 'delete_card':
      return applyDeleteCard(editor, op)
    case 'create_section':
      return applyCreateSection(editor, op, author, acceptedTokenStamp)
    case 'move_sections':
      return applyMoveSections(editor, op)
    case 'edit_section_text':
      return applyEditSectionText(editor, op, author)
    case 'create_question':
      return applyCreateQuestion(editor, op, author, acceptedTokenStamp)
    case 'group_cards':
      return applyGroupCards(editor, op)
    case 'ungroup_cards':
      return applyUngroupCards(editor, op)
    case 'set_summary':
      return applySetSummary(editor, op)
    case 'set_comment_summary':
      return applySetCommentSummary(editor, op)
    case 'set_question_summary':
      return applySetQuestionSummary(editor, op)
  }
}

/**
 * Apply a change-set to the editor and return the shape ids it touched (deduped),
 * so the caller can glow them as agent presence. By default the whole change-set
 * is one undo step (mark + squash). Accepted initialization materialization may
 * opt out of history entirely; that path deliberately creates no mark.
 */
export interface ApplyChangeSetOptions {
  history?: 'record' | 'ignore'
}

export function applyChangeSet(
  editor: Editor,
  cs: ChangeSet,
  acceptedTokenStamp?: string,
  options: ApplyChangeSetOptions = {},
): TLShapeId[] {
  const affected = new Set<TLShapeId>()
  const apply = () => {
    for (const op of cs.ops) {
      for (const id of applyOp(editor, op, cs.author, acceptedTokenStamp)) affected.add(id)
    }
  }
  if (options.history === 'ignore') {
    editor.run(apply, { history: 'ignore' })
  } else {
    const markId = editor.markHistoryStoppingPoint(`${cs.author}:${cs.id}`)
    apply()
    editor.squashToMark(markId)
  }
  return [...affected]
}
