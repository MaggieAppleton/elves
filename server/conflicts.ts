import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { canvasPathFor, listProjects, projectsRoot } from './projects'
import { canvasEpoch, canvasRevision } from './canvasMetadata'
import { readCanvas } from './store'

/**
 * Syncthing writes a `<name>.sync-conflict-<date>-<time>-<device>.<ext>` file
 * next to the original whenever two machines edit the same file while offline —
 * it never loses either version, it just parks the loser under this name. This
 * marker string is the reliable way to recognize one.
 */
const CONFLICT_MARKER = '.sync-conflict-'

/**
 * Return absolute paths of every Syncthing conflict file anywhere under the
 * data root's `projects/` tree, sorted for stable output. Best-effort: a missing
 * projects dir (fresh install) yields an empty list rather than throwing.
 */
export async function findSyncConflicts(dataRoot: string): Promise<string[]> {
  const root = projectsRoot(dataRoot)
  let entries: string[]
  try {
    entries = await fs.readdir(root, { recursive: true })
  } catch {
    return []
  }
  return entries
    .filter((rel) => rel.includes(CONFLICT_MARKER))
    .map((rel) => join(root, rel))
    .sort()
}

/**
 * Among a canvas's sync-conflict siblings, find the one that shares its
 * `epoch` (same document lineage) but carries a HIGHER `revision`. That
 * combination is the signature of a real data-loss bug we hit in practice:
 * Syncthing resolves conflicts using its own file version vectors / mtimes,
 * with zero awareness of this app's revision counter, so it can (and did)
 * crown a semantically older save as the on-disk "winner" while shelving a
 * genuinely newer one as the "conflict." A conflict file with a different
 * epoch is an unrelated/reset lineage and must never be treated as ahead of
 * the live one — auto-merging across epochs would resurrect a dead branch.
 * Read-only: never writes, never throws (an unreadable/mid-sync/corrupt
 * sibling is skipped, not fatal).
 */
export async function findAheadConflict(
  canvasPath: string,
): Promise<{ path: string; revision: number } | null> {
  const dir = dirname(canvasPath)
  const stem = basename(canvasPath).replace(/\.json$/, '')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const siblings = entries.filter(
    (name) => name.startsWith(`${stem}.sync-conflict-`) && name.endsWith('.json'),
  )
  if (siblings.length === 0) return null

  let liveEpoch: string | null
  let liveRevision: number
  try {
    const live = await readCanvas(canvasPath)
    liveEpoch = canvasEpoch(live)
    liveRevision = canvasRevision(live)
  } catch {
    return null
  }
  if (liveEpoch === null) return null

  let best: { path: string; revision: number } | null = null
  for (const name of siblings) {
    const path = join(dir, name)
    try {
      const snapshot = await readCanvas(path)
      if (canvasEpoch(snapshot) !== liveEpoch) continue
      const revision = canvasRevision(snapshot)
      if (revision > liveRevision && (!best || revision > best.revision)) best = { path, revision }
    } catch {
      // Corrupt or mid-write conflict file: not our concern here.
    }
  }
  return best
}

/**
 * Log a clear, advisory warning if any Syncthing conflict files exist, so a
 * cross-machine divergence surfaces loudly at startup instead of hiding. Purely
 * informational — it never modifies or resolves anything, and never throws (a
 * startup diagnostic must not be able to stop the server booting).
 *
 * Conflicts that are actually AHEAD of the live canvas (same epoch, higher
 * revision — see findAheadConflict) get a much louder, distinct line, since
 * those mean real, recoverable data loss rather than routine sync noise.
 */
export async function warnOnSyncConflicts(
  dataRoot: string,
  log: (msg: string) => void = console.warn,
): Promise<void> {
  try {
    const conflicts = await findSyncConflicts(dataRoot)
    if (conflicts.length === 0) return
    log(
      `[elves] ⚠ Syncthing conflict files detected (${conflicts.length}). Your projects ` +
        `may have diverged across machines — review and resolve each, then delete it:`,
    )
    for (const path of conflicts) log(`[elves]   ${path}`)
  } catch {
    // Best-effort diagnostic: never block startup.
  }

  try {
    for (const project of await listProjects(dataRoot)) {
      const canvasPath = canvasPathFor(dataRoot, project.id)
      if (!canvasPath) continue
      const ahead = await findAheadConflict(canvasPath)
      if (!ahead) continue
      log(
        `[elves] 🚨 POSSIBLE DATA LOSS in project "${project.name}" (${project.id}): the live ` +
          `canvas is BEHIND ${ahead.path} (revision ${ahead.revision}). Open this project and ` +
          `resolve before editing further, or you may be building on top of lost work.`,
      )
    }
  } catch {
    // Best-effort diagnostic: never block startup.
  }
}
