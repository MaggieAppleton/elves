import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

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

// A `writeCanvas`/`clearCanvas` guard (see store.ts) that re-checks a project
// still lives at `id` at the moment it's called — not when the caller first
// resolved its paths. A request handler resolves `id`'s canvas/assets paths up
// front (requireProject), but a rename can land in the gap between that and
// the write actually running; passing this guard makes the write refuse
// instead of recreating the old, renamed-away directory.
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
  const root = projectsRoot(dataRoot)
  // Idempotent/safe: creates the projects root once so the per-project mkdir
  // below can be non-recursive.
  await fs.mkdir(root, { recursive: true })

  // firstFreeN is a best-effort starting guess from a directory snapshot; a
  // concurrent createProject racing for the same name can invalidate it
  // between the read and now. The non-recursive mkdir is what actually
  // decides ownership of an id: it's atomic, so it fails with EEXIST if
  // another create just claimed that folder. On EEXIST we walk to the next
  // candidate in the same base/-2/-3 sequence and retry, rather than trusting
  // the initial read.
  let n = await firstFreeN(dataRoot, base)
  for (let attempt = 0; ; attempt++) {
    const id = candidateId(base, n)
    const dir = join(root, id)
    try {
      await fs.mkdir(dir)
      const meta: Project = { id, name: trimmed, createdAt }
      await fs.writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
      // No canvas.json until first save: readCanvas() returns EMPTY_CANVAS for
      // a missing file, and saveAsset() creates assets/ lazily.
      return meta
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (attempt + 1 >= MAX_CREATE_ATTEMPTS) {
        throw new ProjectError('could not allocate a unique project id', 500)
      }
      n++
    }
  }
}

export async function renameProject(
  dataRoot: string,
  id: string,
  name: string,
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  const proj = await getProject(dataRoot, id)
  if (!proj) throw new ProjectError('unknown project', 404)

  // Keep the id in sync with the display name. If the new name slugs to a
  // different id, move the project's folder to it (uniqueId disambiguates a
  // clash with a *different* project, and excludes this project so it can
  // reclaim its own natural slug). A name whose slug is unchanged — or only
  // differs by punctuation/case — is a cheap name-only rewrite.
  const desired = slugify(trimmed)
  const newId = desired === id ? id : await uniqueId(dataRoot, desired, id)
  const updated: Project = { ...proj, id: newId, name: trimmed }
  if (newId !== id) {
    await fs.rename(
      join(projectsRoot(dataRoot), id),
      join(projectsRoot(dataRoot), newId),
    )
  }
  await fs.writeFile(
    join(projectsRoot(dataRoot), newId, 'project.json'),
    JSON.stringify(updated, null, 2),
    'utf8',
  )
  return updated
}

// One-time, idempotent reconciliation run at startup: bring every project's id
// back in line with its display name, the way renameProject now does on each
// edit. Fixes projects created before ids tracked the name (or renamed under the
// old behaviour). A second run finds every id already == slugify(name) and does
// nothing. uniqueId re-reads the folder listing on each call and excludes the
// project being moved, so a batch stays clash-safe and deterministic.
export async function resyncProjectIds(dataRoot: string): Promise<void> {
  for (const proj of await listProjects(dataRoot)) {
    // listProjects already filters out entries with a missing/blank name, but
    // guard here too so no future caller can reach slugify(undefined).
    if (!proj.name) continue
    const desired = slugify(proj.name)
    if (desired === proj.id) continue
    const newId = await uniqueId(dataRoot, desired, proj.id)
    if (newId === proj.id) continue
    await fs.rename(
      join(projectsRoot(dataRoot), proj.id),
      join(projectsRoot(dataRoot), newId),
    )
    await fs.writeFile(
      join(projectsRoot(dataRoot), newId, 'project.json'),
      JSON.stringify({ ...proj, id: newId }, null, 2),
      'utf8',
    )
    console.log(`[elves] project id resynced: ${proj.id} -> ${newId}`)
  }
}
