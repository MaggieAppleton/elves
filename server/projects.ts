import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  withProjectLock,
  withProjectLocks,
  withProjectNamespaceLock,
} from './projectLock'

export interface Project {
  id: string
  name: string
  createdAt: string
}

export class ProjectError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

export class ProjectRenameRollbackError extends Error {
  constructor(
    readonly oldId: string,
    readonly newId: string,
    readonly commitError: unknown,
    readonly rollbackError: unknown,
    readonly cleanupError: unknown = null,
  ) {
    super(`project rename commit failed and rollback failed: ${oldId} -> ${newId}`)
    this.name = 'ProjectRenameRollbackError'
  }
}

export interface RenameProjectOptions {
  rename?: (oldPath: string, newPath: string) => Promise<void>
}

export function projectsRoot(dataRoot: string): string {
  return join(dataRoot, 'projects')
}

// An id is a single, filesystem-safe path segment: lowercase slug, no dots, no
// separators, no traversal. This is the guard that keeps a project id from ever
// escaping data/projects/.
export function isValidId(id: string): boolean {
  return (
    !!id &&
    id === basename(id) &&
    !id.startsWith('.') &&
    !id.includes('..') &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
  )
}

export function projectDir(dataRoot: string, id: string): string | null {
  return isValidId(id) ? join(projectsRoot(dataRoot), id) : null
}

export function canvasPathFor(dataRoot: string, id: string): string | null {
  const dir = projectDir(dataRoot, id)
  return dir && join(dir, 'canvas.json')
}

export function assetsDirFor(dataRoot: string, id: string): string | null {
  const dir = projectDir(dataRoot, id)
  return dir && join(dir, 'assets')
}

export function slugify(name: string): string {
  const s = (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s || 'project'
}

export async function listProjects(dataRoot: string): Promise<Project[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(projectsRoot(dataRoot))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: Project[] = []
  for (const id of entries) {
    try {
      const meta = JSON.parse(
        await fs.readFile(join(projectsRoot(dataRoot), id, 'project.json'), 'utf8'),
      ) as Project
      // Treat a hand-edited, older-format, or partially-written project.json
      // (valid JSON but missing/blank required fields) the same as an
      // unreadable one: skip it rather than surfacing undefined downstream.
      if (typeof meta.name !== 'string' || !meta.name) continue
      if (typeof meta.createdAt !== 'string' || !meta.createdAt) continue
      out.push({ id, name: meta.name, createdAt: meta.createdAt })
    } catch {
      // Skip anything that isn't a readable project folder.
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return out
}

export async function getProject(dataRoot: string, id: string): Promise<Project | null> {
  if (!isValidId(id)) return null
  try {
    const meta = JSON.parse(
      await fs.readFile(join(projectsRoot(dataRoot), id, 'project.json'), 'utf8'),
    ) as Project
    // A malformed meta (hand-edited, older format, or partial write) is
    // treated as "not found", matching callers that only check truthiness.
    if (typeof meta.name !== 'string' || !meta.name) return null
    if (typeof meta.createdAt !== 'string' || !meta.createdAt) return null
    return { id, name: meta.name, createdAt: meta.createdAt }
  } catch {
    return null
  }
}

// A compatibility guard for direct store callers that resolve a project path
// outside the project lock. HTTP mutations instead acquire the project lock,
// then revalidate the project and resolve its paths inside that boundary.
export function projectAliveGuard(dataRoot: string, id: string): () => Promise<boolean> {
  return async () => (await getProject(dataRoot, id)) !== null
}

// The Nth candidate id for `base`: the bare slug, then -2, -3, … Shared by
// uniqueId (which picks the first untaken one from a directory listing) and
// createProject's atomic-create retry loop (which walks the same sequence
// against whatever mkdir actually finds on disk, since a concurrent create can
// invalidate a pre-read "taken" set between the check and the write).
function candidateId(base: string, n: number): string {
  return n === 1 ? base : `${base}-${n}`
}

// The first n (1-based) whose candidateId isn't already taken on disk.
// `exclude` drops one id (a project's own current id) from the "taken" set, so
// re-slugging a project never collides with itself and can reclaim its
// natural slug. This is a best-effort starting point, not a guarantee — a
// concurrent create can still claim it first, which is why createProject
// treats the atomic mkdir, not this read, as the source of truth.
//
// The taken-set is the RAW on-disk folder listing, not listProjects(): a
// malformed/partial project folder is skipped by listProjects but still
// physically occupies its slug (with its own canvas.json/assets). Reading the
// directory directly keeps those folders blocking slug reuse, so a new project
// can never mkdir into and inherit an existing folder's contents.
async function firstFreeN(dataRoot: string, base: string, exclude?: string): Promise<number> {
  let taken: Set<string>
  try {
    taken = new Set(await fs.readdir(projectsRoot(dataRoot)))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') taken = new Set()
    else throw e
  }
  if (exclude) taken.delete(exclude)
  for (let n = 1; ; n++) {
    if (!taken.has(candidateId(base, n))) return n
  }
}

// Find a free id for `base`, disambiguating a clash with an existing project by
// appending -2, -3, …
async function uniqueId(dataRoot: string, base: string, exclude?: string): Promise<string> {
  return candidateId(base, await firstFreeN(dataRoot, base, exclude))
}

// Cap on id-collision retries in createProject: comfortably more than any
// real naming clash would need, just a backstop against an unbounded loop if
// something is badly wrong (e.g. the directory is unwritable in a way that
// doesn't surface as EEXIST).
const MAX_CREATE_ATTEMPTS = 100

export async function createProject(
  dataRoot: string,
  name: string,
  createdAt: string,
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  const base = slugify(trimmed)
  return withProjectNamespaceLock(dataRoot, async () => {
    const root = projectsRoot(dataRoot)
    await fs.mkdir(root, { recursive: true })
    let n = await firstFreeN(dataRoot, base)
    for (let attempt = 0; ; attempt++, n++) {
      const id = candidateId(base, n)
      const created = await withProjectLock(dataRoot, id, async () => {
        try {
          await fs.mkdir(join(root, id))
          const meta: Project = { id, name: trimmed, createdAt }
          await fs.writeFile(join(root, id, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
          return meta
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
          throw error
        }
      })
      if (created) return created
      if (attempt + 1 >= MAX_CREATE_ATTEMPTS) {
        throw new ProjectError('could not allocate a unique project id', 500)
      }
    }
  })
}

export async function renameProject(
  dataRoot: string,
  id: string,
  name: string,
  options: RenameProjectOptions = {},
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  return withProjectNamespaceLock(dataRoot, async () => {
    const desired = slugify(trimmed)
    const newId = desired === id ? id : await uniqueId(dataRoot, desired, id)
    return withProjectLocks(dataRoot, [id, newId], async () => {
      const proj = await getProject(dataRoot, id)
      if (!proj) throw new ProjectError('unknown project', 404)
      const updated: Project = { ...proj, id: newId, name: trimmed }
      const rename = options.rename ?? fs.rename
      const root = projectsRoot(dataRoot)
      const oldDir = join(root, id)
      const newDir = join(root, newId)
      const tempName = `.project.json.${process.pid}.${randomUUID()}.tmp`
      const oldTempPath = join(oldDir, tempName)
      const newTempPath = join(newDir, tempName)
      await fs.writeFile(
        oldTempPath,
        JSON.stringify(updated, null, 2),
        { encoding: 'utf8', flag: 'wx' },
      )

      if (newId === id) {
        try {
          await rename(oldTempPath, join(oldDir, 'project.json'))
        } catch (commitError) {
          const cleanupError = await removeRenameTemp(oldTempPath)
          if (cleanupError) {
            throw new AggregateError(
              [commitError, cleanupError],
              'project metadata commit and temp cleanup failed',
            )
          }
          throw commitError
        }
        return updated
      }

      try {
        await rename(oldDir, newDir)
      } catch (moveError) {
        const cleanupError = await removeRenameTemp(oldTempPath)
        if (cleanupError) {
          throw new AggregateError(
            [moveError, cleanupError],
            'project directory move and temp cleanup failed',
          )
        }
        throw moveError
      }

      try {
        await rename(newTempPath, join(newDir, 'project.json'))
      } catch (commitError) {
        let rollbackError: unknown = null
        try {
          await rename(newDir, oldDir)
        } catch (error) {
          rollbackError = error
        }
        const cleanupError = await removeRenameTemp(
          rollbackError === null ? oldTempPath : newTempPath,
        )
        if (rollbackError !== null) {
          throw new ProjectRenameRollbackError(
            id, newId, commitError, rollbackError, cleanupError,
          )
        }
        if (cleanupError) {
          throw new AggregateError(
            [commitError, cleanupError],
            'project metadata commit and temp cleanup failed after rollback',
          )
        }
        throw commitError
      }
      return updated
    })
  })
}

async function removeRenameTemp(path: string): Promise<unknown | null> {
  try {
    await fs.rm(path, { force: true })
    return null
  } catch (error) {
    return error
  }
}

// One-time, idempotent reconciliation run at startup: bring every project's id
// back in line with its display name, the way renameProject now does on each
// edit. Fixes projects created before ids tracked the name (or renamed under the
// old behaviour). A second run finds every id already == slugify(name) and does
// nothing. uniqueId re-reads the folder listing on each call and excludes the
// project being moved, so a batch stays clash-safe and deterministic.
export async function resyncProjectIds(dataRoot: string): Promise<void> {
  await withProjectNamespaceLock(dataRoot, async () => {
    for (const proj of await listProjects(dataRoot)) {
      if (!proj.name) continue
      const desired = slugify(proj.name)
      if (desired === proj.id) continue
      const newId = await uniqueId(dataRoot, desired, proj.id)
      if (newId === proj.id) continue
      await withProjectLocks(dataRoot, [proj.id, newId], async () => {
        const current = await getProject(dataRoot, proj.id)
        if (!current) return
        const currentDesired = slugify(current.name)
        if (currentDesired === current.id) return
        const currentNewId = await uniqueId(dataRoot, currentDesired, current.id)
        if (currentNewId !== newId) return
        await fs.rename(
          join(projectsRoot(dataRoot), current.id),
          join(projectsRoot(dataRoot), newId),
        )
        await fs.writeFile(
          join(projectsRoot(dataRoot), newId, 'project.json'),
          JSON.stringify({ ...current, id: newId }, null, 2),
          'utf8',
        )
        console.log(`[elves] project id resynced: ${current.id} -> ${newId}`)
      })
    }
  })
}
