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

type CardCandidate = ReturnType<typeof snapshotToSummarizableCards>[number]
type CommentCandidate = ReturnType<typeof snapshotToSummarizableComments>[number]
type QuestionCandidate = ReturnType<typeof snapshotToSummarizableQuestions>[number]

function groupUniqueByKey<T>(items: T[], keyOf: (item: T) => string): {
  uniqueByKey: Map<string, T>
  ambiguousKeys: Set<string>
} {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  const uniqueByKey = new Map<string, T>()
  const ambiguousKeys = new Set<string>()
  for (const [key, group] of groups) {
    if (group.length === 1) uniqueByKey.set(key, group[0])
    else ambiguousKeys.add(key)
  }
  return { uniqueByKey, ambiguousKeys }
}

interface SummaryCandidates {
  cards: CardCandidate[]
  comments: CommentCandidate[]
  questions: QuestionCandidate[]
  cardById: Map<string, CardCandidate>
  commentById: Map<string, CommentCandidate>
  questionById: Map<string, QuestionCandidate>
  ambiguousCardIds: Set<string>
  ambiguousCommentIds: Set<string>
  ambiguousQuestionIds: Set<string>
}

function commentKey(comment: Pick<CommentCandidate, 'cardId' | 'commentId'>): string {
  return `${comment.cardId}\0${comment.commentId}`
}

function summaryCandidates(snapshot: Parameters<typeof snapshotToSummarizableCards>[0]): SummaryCandidates {
  const cardGroups = groupUniqueByKey(snapshotToSummarizableCards(snapshot), (card) => card.id)
  const commentGroups = groupUniqueByKey(snapshotToSummarizableComments(snapshot), commentKey)
  const questionGroups = groupUniqueByKey(
    snapshotToSummarizableQuestions(snapshot),
    (question) => question.questionId,
  )
  const ambiguousCommentIds = new Set(commentGroups.ambiguousKeys)
  const commentById = new Map<string, CommentCandidate>()
  for (const [key, comment] of commentGroups.uniqueByKey) {
    if (cardGroups.uniqueByKey.has(comment.cardId)) commentById.set(key, comment)
    else if (cardGroups.ambiguousKeys.has(comment.cardId)) ambiguousCommentIds.add(key)
  }
  return {
    cards: [...cardGroups.uniqueByKey.values()],
    comments: [...commentById.values()],
    questions: [...questionGroups.uniqueByKey.values()],
    cardById: cardGroups.uniqueByKey,
    commentById,
    questionById: questionGroups.uniqueByKey,
    ambiguousCardIds: cardGroups.ambiguousKeys,
    ambiguousCommentIds,
    ambiguousQuestionIds: questionGroups.ambiguousKeys,
  }
}

function sameCardCandidate(
  left: CardCandidate,
  right: CardCandidate,
): boolean {
  return left.id === right.id && left.kind === right.kind && left.noteKind === right.noteKind &&
    left.text === right.text && left.summary === right.summary &&
    left.summaryOfHash === right.summaryOfHash
}

function sameCommentCandidate(
  left: CommentCandidate,
  right: CommentCandidate,
): boolean {
  return left.cardId === right.cardId && left.commentId === right.commentId &&
    left.text === right.text && left.summary === right.summary &&
    left.summaryOfHash === right.summaryOfHash
}

function sameQuestionCandidate(
  left: QuestionCandidate,
  right: QuestionCandidate,
): boolean {
  return left.questionId === right.questionId && left.text === right.text &&
    left.summary === right.summary && left.summaryOfHash === right.summaryOfHash
}

function validSummaryOpsForSnapshot(
  ops: SummaryOp[],
  original: SummaryCandidates,
  fresh: Parameters<typeof snapshotToSummarizableCards>[0],
): { validOps: SummaryOp[]; retryDiscarded: boolean } {
  const current = summaryCandidates(fresh)
  const validOps: SummaryOp[] = []
  let retryDiscarded = false
  for (const op of ops) {
    if (op.kind === 'set_summary') {
      if (current.ambiguousCardIds.has(op.cardId)) continue
      const originalCard = original.cardById.get(op.cardId)
      const currentCard = current.cardById.get(op.cardId)
      if (!originalCard || !currentCard || !sameCardCandidate(originalCard, currentCard)) {
        retryDiscarded = true
        continue
      }
      const expectedState = op.summary === null ? 'clear' : 'generate'
      if (summaryState(originalCard) === expectedState &&
        summaryState(currentCard) === expectedState) validOps.push(op)
      else retryDiscarded = true
      continue
    } else if (op.kind === 'set_comment_summary') {
      const key = commentKey(op)
      if (current.ambiguousCardIds.has(op.cardId) || current.ambiguousCommentIds.has(key)) continue
      const originalComment = original.commentById.get(key)
      const currentComment = current.commentById.get(key)
      if (!originalComment || !currentComment ||
        !sameCommentCandidate(originalComment, currentComment)) {
        retryDiscarded = true
        continue
      }
      const expectedState = op.summary === null ? 'clear' : 'generate'
      if (commentSummaryState(originalComment) === expectedState &&
        commentSummaryState(currentComment) === expectedState) validOps.push(op)
      else retryDiscarded = true
      continue
    }
    if (current.ambiguousQuestionIds.has(op.questionId)) continue
    const originalQuestion = original.questionById.get(op.questionId)
    const currentQuestion = current.questionById.get(op.questionId)
    if (!originalQuestion || !currentQuestion ||
      !sameQuestionCandidate(originalQuestion, currentQuestion)) {
      retryDiscarded = true
      continue
    }
    const expectedState = op.summary === null ? 'clear' : 'generate'
    if (commentSummaryState(originalQuestion) === expectedState &&
      commentSummaryState(currentQuestion) === expectedState) validOps.push(op)
    else retryDiscarded = true
  }
  return { validOps, retryDiscarded }
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
  const candidates = summaryCandidates(canvas)
  const { cards, comments, questions } = candidates

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
      const validated = validSummaryOpsForSnapshot(ops, candidates, fresh)
      const { validOps } = validated
      discarded = validated.retryDiscarded
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
