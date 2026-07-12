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

// A trailing-edge debounce with a `flush()` escape hatch: flush cancels the
// pending timer and invokes the last call immediately (a no-op if nothing is
// pending). The resync path uses this to force a held autosave to the server
// *now*, before it re-fetches the canvas — otherwise the in-flight keystrokes
// still sitting in the 500ms window would be reverted by the reload.
export function debounce<A extends any[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  let lastArgs: A | undefined
  const debounced = (...a: A) => {
    lastArgs = a
    clearTimeout(t)
    t = setTimeout(() => {
      t = undefined
      fn(...a)
    }, ms)
  }
  debounced.flush = () => {
    if (t === undefined) return
    clearTimeout(t)
    t = undefined
    if (lastArgs) fn(...lastArgs)
  }
  return debounced
}

// Wraps a fire-and-forget async save so overlapping requests never drop the
// latest state: if a request comes in while one is already in flight, it's
// marked dirty and re-run (capturing fresh state) once the in-flight save
// settles, instead of being silently dropped.
export function createSaver(saveFn: () => Promise<void>) {
  let saving = false
  let pendingDirty = false
  // Resolvers for whenIdle() callers waiting on the current save (and any queued
  // retry) to settle. Drained the moment the saver goes fully idle.
  const idleResolvers: Array<() => void> = []
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
        } else {
          for (const resolve of idleResolvers.splice(0)) resolve()
        }
      })
  }
  // Resolves once no save is in flight and none is queued — so a caller can wait
  // for a just-flushed autosave to actually reach the server before it acts (the
  // resync waits on this before re-fetching, so it never loads stale text).
  const whenIdle = () =>
    saving || pendingDirty
      ? new Promise<void>((resolve) => idleResolvers.push(resolve))
      : Promise.resolve()
  return { request: run, whenIdle }
}
