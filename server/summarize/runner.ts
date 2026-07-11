import type { ChangeSet } from '../../src/model/changeset'
import { readCanvas, withCanvasLock } from '../store'
import {
  snapshotToSummarizableCards, snapshotToSummarizableComments, snapshotToSummarizableQuestions,
} from '../digest'
import { applyChangeSetToSnapshot } from '../applyChangeSet'
import { reconcileSummaries, reconcileCommentSummaries, reconcileQuestionSummaries } from './reconcile'
import type { Summarizer } from './summarizer'

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
 */
export async function reconcileCanvasFile(
  canvasPath: string,
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const canvas = await readCanvas(canvasPath)
  const cardCs = await reconcileSummaries(snapshotToSummarizableCards(canvas), summarizer, now)
  const commentCs = await reconcileCommentSummaries(snapshotToSummarizableComments(canvas), summarizer, now)
  const questionCs = await reconcileQuestionSummaries(
    snapshotToSummarizableQuestions(canvas), summarizer, now,
  )
  const ops = [
    ...(cardCs?.ops ?? []), ...(commentCs?.ops ?? []), ...(questionCs?.ops ?? []),
  ]
  if (!ops.length) return null
  const cs: ChangeSet = { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
  await withCanvasLock(canvasPath, (fresh) => applyChangeSetToSnapshot(fresh, cs))
  return cs
}
