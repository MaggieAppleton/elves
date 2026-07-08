import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot } from './projects'

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
 * Log a clear, advisory warning if any Syncthing conflict files exist, so a
 * cross-machine divergence surfaces loudly at startup instead of hiding. Purely
 * informational — it never modifies or resolves anything, and never throws (a
 * startup diagnostic must not be able to stop the server booting).
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
}
