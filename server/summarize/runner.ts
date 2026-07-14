import type { ChangeSet, Op } from '../../src/model/changeset'
import { readCanvas, withCanvasLock } from '../store'
import {
  snapshotToSummarizableCards, snapshotToSummarizableComments, snapshotToSummarizableQuestions,
} from '../digest'
import { applyChangeSetToSnapshot } from '../applyChangeSet'
import { reconcileSummaries, reconcileCommentSummaries, reconcileQuestionSummaries } from './reconcile'
import type { Summarizer } from './summarizer'
import { summaryState, commentSummaryState } from '../../src/model/summary'
import { canvasPathFor, getProject } from '../projects'
import { withProjectLock } from '../projectLock'
import { incrementCanvasRevision } from '../canvasMetadata'

type SummaryOp = Extract<Op,
  | { kind: 'set_summary' }
  | { kind: 'set_comment_summary' }
  | { kind: 'set_question_summary' }
>

function sameCardCandidate(
  left: ReturnType<typeof snapshotToSummarizableCards>[number],
  right: ReturnType<typeof snapshotToSummarizableCards>[number],
): boolean {
  return left.id === right.id && left.kind === right.kind && left.noteKind === right.noteKind &&
    left.text === right.text && left.summary === right.summary &&
    left.summaryOfHash === right.summaryOfHash
}

function sameCommentCandidate(
  left: ReturnType<typeof snapshotToSummarizableComments>[number],
  right: ReturnType<typeof snapshotToSummarizableComments>[number],
): boolean {
  return left.cardId === right.cardId && left.commentId === right.commentId &&
    left.text === right.text && left.summary === right.summary &&
    left.summaryOfHash === right.summaryOfHash
}

function sameQuestionCandidate(
  left: ReturnType<typeof snapshotToSummarizableQuestions>[number],
  right: ReturnType<typeof snapshotToSummarizableQuestions>[number],
): boolean {
  return left.questionId === right.questionId && left.text === right.text &&
    left.summary === right.summary && left.summaryOfHash === right.summaryOfHash
}

function validSummaryOpsForSnapshot(
  ops: SummaryOp[],
  originalCards: ReturnType<typeof snapshotToSummarizableCards>,
  originalComments: ReturnType<typeof snapshotToSummarizableComments>,
  originalQuestions: ReturnType<typeof snapshotToSummarizableQuestions>,
  fresh: Parameters<typeof snapshotToSummarizableCards>[0],
): SummaryOp[] {
  const freshCards = new Map(snapshotToSummarizableCards(fresh).map((card) => [card.id, card]))
  const freshComments = new Map(snapshotToSummarizableComments(fresh)
    .map((comment) => [`${comment.cardId}\0${comment.commentId}`, comment]))
  const freshQuestions = new Map(snapshotToSummarizableQuestions(fresh)
    .map((question) => [question.questionId, question]))
  const originalCardById = new Map(originalCards.map((card) => [card.id, card]))
  const originalCommentById = new Map(originalComments
    .map((comment) => [`${comment.cardId}\0${comment.commentId}`, comment]))
  const originalQuestionById = new Map(originalQuestions
    .map((question) => [question.questionId, question]))

  return ops.filter((op) => {
    if (op.kind === 'set_summary') {
      const original = originalCardById.get(op.cardId)
      const current = freshCards.get(op.cardId)
      if (!original || !current || !sameCardCandidate(original, current)) return false
      const expectedState = op.summary === null ? 'clear' : 'generate'
      return summaryState(original) === expectedState && summaryState(current) === expectedState
    }
    if (op.kind === 'set_comment_summary') {
      const key = `${op.cardId}\0${op.commentId}`
      const original = originalCommentById.get(key)
      const current = freshComments.get(key)
      if (!original || !current || !sameCommentCandidate(original, current)) return false
      const expectedState = op.summary === null ? 'clear' : 'generate'
      return commentSummaryState(original) === expectedState &&
        commentSummaryState(current) === expectedState
    }
    const original = originalQuestionById.get(op.questionId)
    const current = freshQuestions.get(op.questionId)
    if (!original || !current || !sameQuestionCandidate(original, current)) return false
    const expectedState = op.summary === null ? 'clear' : 'generate'
    return commentSummaryState(original) === expectedState &&
      commentSummaryState(current) === expectedState
  })
}

/**
 * Read a project's canvas, generate any needed summary updates (for cards,
 * their comments, AND questions — all three are summarized by the identical
 * pipeline, just keyed to their own id), persist them, and return the combined
 * change-set (for the caller to broadcast) or null if nothing changed. The
 * (possibly slow) summarizer calls run against an initial read, outside any
 * lock; applying the result is done inside withCanvasLock, so the
 * apply-against-the-latest-snapshot and the write happen as one atomic step
 * relative to any concurrent save or change-set — a slow summarizer run can't
 * clobber a user save that landed in the meantime. Each candidate's source and
 * summary decision state are revalidated against that fresh snapshot; stale
 * model results are discarded and reported pending for regeneration.
 *
 * `pending` reports whether generate-state work remains unfilled — the
 * summarizer returns null for both "unreachable" and "nothing to do", so we
 * detect unreachability structurally: count units in `generate` state before
 * the run, then count how many actually got filled (emitted a set_* op
 * carrying a non-null summary). Fewer filled than wanted means the summarizer
 * couldn't keep up (e.g. Ollama was down) — the caller can use this to retry
 * once it recovers.
 */
export async function reconcileCanvasFile(
  dataRoot: string,
  projectId: string,
  summarizer: Summarizer,
  now: () => string,
): Promise<{ changeSet: ChangeSet | null; pending: boolean }> {
  const canvasPath = canvasPathFor(dataRoot, projectId)
  if (!canvasPath) return { changeSet: null, pending: false }
  const canvas = await readCanvas(canvasPath)
  const cards = snapshotToSummarizableCards(canvas)
  const comments = snapshotToSummarizableComments(canvas)
  const questions = snapshotToSummarizableQuestions(canvas)

  const generateCount =
    cards.filter((c) => summaryState(c) === 'generate').length +
    comments.filter((c) => commentSummaryState(c) === 'generate').length +
    questions.filter((q) => commentSummaryState(q) === 'generate').length

  const cardCs = await reconcileSummaries(cards, summarizer, now)
  const commentCs = await reconcileCommentSummaries(comments, summarizer, now)
  const questionCs = await reconcileQuestionSummaries(questions, summarizer, now)
  const ops = [
    ...(cardCs?.ops ?? []),
    ...(commentCs?.ops ?? []),
    ...(questionCs?.ops ?? []),
  ] as SummaryOp[]

  const filledCount = ops.filter((o) => 'summary' in o && o.summary !== null).length
  const pending = filledCount < generateCount

  if (!ops.length) return { changeSet: null, pending }
  const cs: ChangeSet = { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
  return withProjectLock(dataRoot, projectId, async () => {
    if (!(await getProject(dataRoot, projectId))) return { changeSet: null, pending }
    const currentCanvasPath = canvasPathFor(dataRoot, projectId)
    if (!currentCanvasPath) return { changeSet: null, pending }
    let appliedChangeSet: ChangeSet | null = null
    let discarded = false
    await withCanvasLock(currentCanvasPath, (fresh) => {
      const validOps = validSummaryOpsForSnapshot(ops, cards, comments, questions, fresh)
      discarded = validOps.length !== ops.length
      if (validOps.length === 0) return null
      const filtered: ChangeSet = { ...cs, ops: validOps }
      const applied = applyChangeSetToSnapshot(fresh, filtered)
      if (!applied || JSON.stringify(applied) === JSON.stringify(fresh)) {
        discarded = true
        return null
      }
      appliedChangeSet = filtered
      return incrementCanvasRevision(applied)
    })
    return { changeSet: appliedChangeSet, pending: pending || discarded }
  })
}
