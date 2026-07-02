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
  const s = name
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
    return { id, name: meta.name, createdAt: meta.createdAt }
  } catch {
    return null
  }
}

async function uniqueId(dataRoot: string, base: string): Promise<string> {
  const taken = new Set((await listProjects(dataRoot)).map((p) => p.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function createProject(
  dataRoot: string,
  name: string,
  createdAt: string,
): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  const id = await uniqueId(dataRoot, slugify(trimmed))
  const dir = join(projectsRoot(dataRoot), id)
  await fs.mkdir(dir, { recursive: true })
  const meta: Project = { id, name: trimmed, createdAt }
  await fs.writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
  // No canvas.json until first save: readCanvas() returns EMPTY_CANVAS for a
  // missing file, and saveAsset() creates assets/ lazily.
  return meta
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
  const updated: Project = { ...proj, name: trimmed }
  await fs.writeFile(
    join(projectsRoot(dataRoot), id, 'project.json'),
    JSON.stringify(updated, null, 2),
    'utf8',
  )
  return updated
}
