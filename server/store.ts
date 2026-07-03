import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export type CanvasSnapshot = Record<string, unknown>

export const EMPTY_CANVAS: CanvasSnapshot = { document: null, session: null }

export async function readCanvas(path: string): Promise<CanvasSnapshot> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_CANVAS }
    }
    throw err
  }
  // An empty file means a torn/partial write (or a freshly-touched file). Treat
  // it like a missing canvas instead of crashing on JSON.parse(''). A non-empty
  // file that fails to parse is genuine corruption, so we let that throw.
  if (raw.trim() === '') return { ...EMPTY_CANVAS }
  return JSON.parse(raw) as CanvasSnapshot
}

// Serialize all writes through a single promise chain so two writes can never
// interleave on disk, and give each write a unique temp file so even an
// out-of-band writer (a second process, a manual script) can't collide on the
// temp path — the collision that caused ENOENT-on-rename crashes.
let writeChain: Promise<void> = Promise.resolve()
let tmpSeq = 0

export function writeCanvas(path: string, data: CanvasSnapshot): Promise<void> {
  // Chain off the previous write regardless of whether it resolved or rejected,
  // so one failed write never stalls the queue for the next one.
  const run = writeChain.then(
    () => doWrite(path, data),
    () => doWrite(path, data),
  )
  // The chain itself must stay unrejected (an unhandled rejection here would be
  // fatal); the caller still receives the real promise and sees success/failure.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function doWrite(path: string, data: CanvasSnapshot): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  // Preserve the current on-disk document before we overwrite it, so a
  // bad-but-valid write (an empty store saved during a load race, a buggy
  // change-set) is recoverable from `<path>.bak` instead of being permanent.
  // Runs inside the serialized write chain, so no other write interleaves.
  await backupExisting(path)
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

/**
 * Whether a canvas file's current contents are worth keeping as a backup.
 *
 * This predicate is the crux of the never-lose-data guarantee: we only ever let
 * a file that actually carries a document overwrite the rolling `.bak`. A
 * degenerate state — the EMPTY_CANVAS sentinel ({document: null}), an empty/torn
 * file, or corrupt JSON — is rejected, so a bad write can never clobber the last
 * known-good backup with junk (a second empty write finds an empty main file and
 * simply leaves the good `.bak` intact).
 */
export function worthBackingUp(raw: string): boolean {
  if (raw.trim() === '') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  return !!parsed && typeof parsed === 'object' && (parsed as { document?: unknown }).document != null
}

async function backupExisting(path: string): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    // No file yet (first write) or unreadable for any reason: nothing to back
    // up. A backup is best-effort and must never block the primary write.
    return
  }
  if (!worthBackingUp(raw)) return
  try {
    await fs.copyFile(path, `${path}.bak`)
  } catch {
    // A failed backup must never stop the write that follows it.
  }
}
