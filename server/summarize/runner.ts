import type { ChangeSet } from '../../src/model/changeset'
import { readCanvas, withCanvasLock } from '../store'
import { snapshotToSummarizableCards } from '../digest'
import { applyChangeSetToSnapshot } from '../applyChangeSet'
import { reconcileSummaries } from './reconcile'
import type { Summarizer } from './summarizer'

/**
 * Read a project's canvas, generate any needed summary updates, persist them,
 * and return the change-set (for the caller to broadcast) or null if nothing
 * changed. The (possibly slow) summarizer call runs against an initial read,
 * outside any lock; applying its result is done inside withCanvasLock, so the
 * apply-against-the-latest-snapshot and the write happen as one atomic step
 * relative to any concurrent save or change-set — a slow summarizer run can't
 * clobber a user save that landed in the meantime. The set_summary ops only
 * touch summary fields, and any text that changed under them will fail the
 * hash check and be regenerated on the next pass.
 */
export async function reconcileCanvasFile(
  canvasPath: string,
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const canvas = await readCanvas(canvasPath)
  const cs = await reconcileSummaries(snapshotToSummarizableCards(canvas), summarizer, now)
  if (!cs) return null
  await withCanvasLock(canvasPath, (fresh) => applyChangeSetToSnapshot(fresh, cs))
  return cs
}
