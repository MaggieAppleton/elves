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

/**
 * Thrown when a write's caller-supplied guard (see `writeCanvas`'s `stillValid`
 * argument) says the write's target is no longer valid — e.g. the project a
 * canvas path belongs to was renamed (to a new directory) or deleted after the
 * caller resolved its paths but before this write actually ran. The write must
 * refuse rather than recreate the old directory (which would resurrect an
 * orphaned folder containing only canvas.json, with the save missing from the
 * project's real, renamed home).
 */
export class ProjectGoneError extends Error {
  constructor() {
    super('project no longer exists at this path')
    this.name = 'ProjectGoneError'
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

// Serialize writes per project directory (rather than one global chain) so two
// writes to the *same* project can never interleave on disk, while unrelated
// projects don't queue behind each other — a congested chain for project A
// used to widen the window in which a save for project B could race a rename.
// Each write still gets a unique temp file so even an out-of-band writer (a
// second process, a manual script) can't collide on the temp path — the
// collision that caused ENOENT-on-rename crashes.
const writeChains = new Map<string, Promise<void>>()
let tmpSeq = 0

function chainOn(path: string, task: () => Promise<void>): Promise<void> {
  const key = dirname(path)
  const prev = writeChains.get(key) ?? Promise.resolve()
  // Chain off the previous write regardless of whether it resolved or
  // rejected, so one failed write never stalls the queue for the next one.
  const run = prev.then(task, task)
  // The chain itself must stay unrejected (an unhandled rejection here would
  // be fatal); the caller still receives the real promise and sees
  // success/failure.
  writeChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * @param stillValid Optional guard checked immediately before the write, inside
 *   this write's serialized per-directory task — so no queue delay can widen
 *   the window between a caller resolving `path` and the write actually
 *   touching disk. If it resolves `false`, the write is refused with
 *   `ProjectGoneError` instead of proceeding to (re)create `path`'s directory.
 *   store.ts itself has no notion of "project" — callers that write into a
 *   project's directory (see server/app.ts) pass a guard that re-checks the
 *   project still exists; generic/standalone callers (and this module's own
 *   tests) may omit it and keep the old create-directory-as-needed behavior.
 */
export function writeCanvas(
  path: string,
  data: CanvasSnapshot,
  stillValid?: () => Promise<boolean>,
): Promise<void> {
  return chainOn(path, () => doWrite(path, data, stillValid))
}

async function doWrite(
  path: string,
  data: CanvasSnapshot,
  stillValid?: () => Promise<boolean>,
): Promise<void> {
  // Refuse to write — and never recreate a directory the caller's guard says
  // is gone (e.g. a project renamed/deleted between path resolution and this
  // write actually running).
  if (stillValid && !(await stillValid())) {
    throw new ProjectGoneError()
  }
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
 * real document, but a deliberate clear may. Serialized on the same write chain
 * so it can never interleave with a write.
 */
export function clearCanvas(path: string): Promise<void> {
  return chainOn(path, () => doClear(path))
}

async function doClear(path: string): Promise<void> {
  await backupExisting(path)
  await fs.rm(path, { force: true }) // force: a missing canvas is a no-op
}
