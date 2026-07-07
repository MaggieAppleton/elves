import type { Project } from '../../server/projects'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export type { Project }

// --- Projects -------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`)
  if (!res.ok) throw new Error(`list projects failed: ${res.status}`)
  return res.json()
}

export async function createProject(name: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`create project failed: ${res.status}`)
  return res.json()
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`rename project failed: ${res.status}`)
  return res.json()
}

// --- Per-project canvas ---------------------------------------------------

export async function loadCanvas(projectId: string): Promise<any> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/canvas`)
  if (!res.ok) throw new Error(`load failed: ${res.status}`)
  return res.json()
}

export async function saveCanvas(projectId: string, snapshot: unknown): Promise<void> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/canvas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
}

export function debounce<A extends any[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

// Wraps a fire-and-forget async save so overlapping requests never drop the
// latest state: if a request comes in while one is already in flight, it's
// marked dirty and re-run (capturing fresh state) once the in-flight save
// settles, instead of being silently dropped.
export function createSaver(saveFn: () => Promise<void>) {
  let saving = false
  let pendingDirty = false
  const run = () => {
    if (saving) {
      pendingDirty = true
      return
    }
    saving = true
    saveFn()
      .catch((err) => console.error('Elves: canvas save failed', err))
      .finally(() => {
        saving = false
        if (pendingDirty) {
          pendingDirty = false
          run()
        }
      })
  }
  return { request: run }
}
