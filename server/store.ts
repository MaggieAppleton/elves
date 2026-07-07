import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export type CanvasSnapshot = Record<string, unknown>

export const EMPTY_CANVAS: CanvasSnapshot = { document: null, session: null }

/** Does this snapshot carry a real document (vs. the EMPTY_CANVAS sentinel)? */
export function hasDocument(snap: CanvasSnapshot | null | undefined): boolean {
  return !!snap && typeof snap === 'object' && (snap as { document?: unknown }).document != null
}

/**
 * Thrown when a *save* would blank a canvas that currently holds a real document.
 * Clearing a canvas is an explicit operation (clearCanvas) — it must never happen
 * as a side effect of a save (a misconfigured client, a stray test, a load race).
 */
export class EmptyCanvasOverwriteError extends Error {
  constructor() {
    super('refusing to overwrite a non-empty canvas with an empty one')
    this.name = 'EmptyCanvasOverwriteError'
  }
}

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

// Serialize every read-modify-write against a canvas path through a single
// per-path promise chain, so a read done to decide *what* to write can never go
// stale by the time the write lands — closing the lost-update race where a
// whole-snapshot save and a change-set (or two change-sets) both read the same
// on-disk state and one silently overwrites the other's already-persisted work.
//
// Keyed by path (not global) so unrelated projects/canvases never wait on each
// other. Each write still gets a unique temp file so even an out-of-band writer
// (a second process, a manual script) can't collide on the temp path — the
// collision that caused ENOENT-on-rename crashes.
const pathChains = new Map<string, Promise<unknown>>()
let tmpSeq = 0

/**
 * Run `task` for `path` after every previously-enqueued task for that SAME
 * path has settled (resolved or rejected) — the shared serialization primitive
 * behind withCanvasLock and clearCanvas. A failed task never stalls the queue
 * for the next caller: the chain always advances.
 */
function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const tail = pathChains.get(path) ?? Promise.resolve()
  const run = tail.then(task, task)
  // The chain itself must stay unrejected (an unhandled rejection here would be
  // fatal); the caller still receives the real promise and sees success/failure.
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  pathChains.set(path, settled)
  // Once this is the last-known task for the path, drop the map entry so it
  // doesn't grow unboundedly across the life of the process.
  void settled.then(() => {
    if (pathChains.get(path) === settled) pathChains.delete(path)
  })
  return run
}

/**
 * Atomically run `fn(current)` against the canvas at `path` relative to every
 * other call for the SAME path: no other reader-writer of this path can read
 * between `fn`'s read and its write. `fn` receives the canvas as it stands at
 * the moment this call reaches the front of the queue, and its return value is
 * persisted — unless it returns `null`, meaning "nothing to write" (mirrors
 * applyChangeSetToSnapshot's null-means-no-op contract).
 */
export function withCanvasLock<T extends CanvasSnapshot | null>(
  path: string,
  fn: (current: CanvasSnapshot) => T | Promise<T>,
): Promise<T> {
  return enqueue(path, async () => {
    const current = await readCanvas(path)
    const next = await fn(current)
    if (next !== null) await doWrite(path, next)
    return next
  })
}

export function writeCanvas(path: string, data: CanvasSnapshot): Promise<void> {
  return withCanvasLock(path, () => data).then(() => undefined)
}

async function doWrite(path: string, data: CanvasSnapshot): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  // A save must never blank a canvas that holds a real document. An incoming
  // snapshot with no document (the EMPTY_CANVAS sentinel) may only land on a
  // canvas that is itself empty or missing — overwriting a real document with
  // nothing is the data-loss case, so we refuse it. Deliberately clearing a
  // canvas is a separate, explicit operation (clearCanvas).
  if (!hasDocument(data)) {
    let existing: string | null = null
    try {
      existing = await fs.readFile(path, 'utf8')
    } catch {
      existing = null // no file yet (or unreadable): nothing to protect
    }
    if (existing !== null && worthBackingUp(existing)) {
      throw new EmptyCanvasOverwriteError()
    }
  }
  // Preserve the current on-disk document before we overwrite it, so a
  // bad-but-valid write (a lossy change-set) is recoverable from `<path>.bak`
  // instead of being permanent. Runs inside the serialized write chain, so no
  // other write interleaves.
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

/**
 * Explicitly clear a canvas: preserve the current document as a `.bak`, then
 * remove the file so a subsequent read returns EMPTY_CANVAS. This is the
 * intentional counterpart to writeCanvas's guard — a *save* may never blank a
 * real document, but a deliberate clear may. Serialized on the same per-path
 * chain as withCanvasLock/writeCanvas so it can never interleave with a write.
 */
export function clearCanvas(path: string): Promise<void> {
  return enqueue(path, () => doClear(path))
}

async function doClear(path: string): Promise<void> {
  await backupExisting(path)
  await fs.rm(path, { force: true }) // force: a missing canvas is a no-op
}
