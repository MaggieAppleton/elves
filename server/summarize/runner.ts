import type { ChangeSet } from '../../src/model/changeset'
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

/**
 * Read a project's canvas, generate any needed summary updates (for cards,
 * their comments, AND questions — all three are summarized by the identical
 * pipeline, just keyed to their own id), persist them, and return the combined
 * change-set (for the caller to broadcast) or null if nothing changed. The
 * (possibly slow) summarizer calls run against an initial read, outside any
 * lock; applying the result is done inside withCanvasLock, so the
 * apply-against-the-latest-snapshot and the write happen as one atomic step
 * relative to any concurrent save or change-set — a slow summarizer run can't
 * clobber a user save that landed in the meantime. The
 * set_summary/set_comment_summary/set_question_summary ops only touch summary
 * fields, and any text that changed under them will fail the hash check and be
 * regenerated on the next pass.
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
  const ops = [...(cardCs?.ops ?? []), ...(commentCs?.ops ?? []), ...(questionCs?.ops ?? [])]

  const filledCount = ops.filter((o) => 'summary' in o && o.summary !== null).length
  const pending = filledCount < generateCount

  if (!ops.length) return { changeSet: null, pending }
  const cs: ChangeSet = { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
  return withProjectLock(dataRoot, projectId, async () => {
    if (!(await getProject(dataRoot, projectId))) return { changeSet: null, pending }
    const currentCanvasPath = canvasPathFor(dataRoot, projectId)
    if (!currentCanvasPath) return { changeSet: null, pending }
    await withCanvasLock(currentCanvasPath, (fresh) => applyChangeSetToSnapshot(fresh, cs))
    return { changeSet: cs, pending }
  })
}
