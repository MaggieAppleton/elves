import type { Project } from '../../server/projects'
import type { ChangeSetToken, PendingChangeSetV2 } from '../../server/canvasMetadata'
import type { CanvasSnapshot } from '../../server/store'
import { isChangeSet } from '../model/changeset'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export type { CanvasSnapshot, ChangeSetToken, PendingChangeSetV2, Project }

export interface CanvasVersionedState {
  snapshot: CanvasSnapshot
  revision: number
  pendingChangeSets: PendingChangeSetV2[]
  nextChangeSetToken: ChangeSetToken
}

interface CanvasProtocolErrorDetails {
  code: string | null
  revision: number | null
  nextChangeSetToken: ChangeSetToken | null
}

export class CanvasProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly revision: number | null,
    readonly nextChangeSetToken: ChangeSetToken | null,
  ) {
    super(message)
    this.name = 'CanvasProtocolError'
  }
}

export class CanvasRevisionConflictError extends CanvasProtocolError {
  constructor(message: string, status: number, readonly serverRevision: number) {
    super(message, status, 'canvas-revision-conflict', serverRevision, null)
    this.name = 'CanvasRevisionConflictError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function tokenFrom(value: unknown): ChangeSetToken | null {
  if (!isRecord(value) || typeof value.epoch !== 'string' || value.epoch.length === 0 ||
    !isNonNegativeSafeInteger(value.sequence)) return null
  return { epoch: value.epoch, sequence: value.sequence }
}

function errorDetails(value: unknown): CanvasProtocolErrorDetails {
  if (!isRecord(value)) return { code: null, revision: null, nextChangeSetToken: null }
  const token = value.nextChangeSetToken
  return {
    code: typeof value.code === 'string' ? value.code : null,
    revision: isNonNegativeSafeInteger(value.revision) ? value.revision : null,
    nextChangeSetToken: tokenFrom(token),
  }
}

function isVersionedState(value: unknown): value is CanvasVersionedState {
  if (!isRecord(value) || !isRecord(value.snapshot) ||
    !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.pendingChangeSets) ||
    tokenFrom(value.nextChangeSetToken) === null) return false
  return value.pendingChangeSets.every((entry) =>
    isRecord(entry) && tokenFrom(entry.token) !== null && isChangeSet(entry.changeSet))
}

function invalidCanvasResponse(response: Response): CanvasProtocolError {
  return new CanvasProtocolError(
    'invalid canvas response', response.status, 'invalid-canvas-response', null, null,
  )
}

async function successJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw invalidCanvasResponse(response)
  }
}

async function protocolError(response: Response, operation: 'load' | 'save'):
Promise<CanvasProtocolError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const details = errorDetails(body)
  const message = isRecord(body) && typeof body.error === 'string'
    ? body.error
    : `${operation} failed: ${response.status}`
  if (response.status === 409 && details.code === 'canvas-revision-conflict' &&
    details.revision !== null) {
    return new CanvasRevisionConflictError(message, response.status, details.revision)
  }
  return new CanvasProtocolError(
    message,
    response.status,
    details.code,
    details.revision,
    details.nextChangeSetToken,
  )
}

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

export async function loadCanvasVersioned(projectId: string): Promise<CanvasVersionedState> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(projectId)}/canvas?protocol=2`,
  )
  if (!res.ok) throw await protocolError(res, 'load')
  const result = await successJson(res)
  if (!isVersionedState(result)) throw invalidCanvasResponse(res)
  return result
}

export async function saveCanvasVersioned(
  projectId: string,
  snapshot: CanvasSnapshot,
  revision: number,
): Promise<number> {
  const res = await fetch(
    `${BASE}/projects/${encodeURIComponent(projectId)}/canvas?protocol=2`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-elves-canvas-revision': String(revision),
      },
      body: JSON.stringify(snapshot),
    },
  )
  if (!res.ok) throw await protocolError(res, 'save')
  const result = await successJson(res)
  if (!isRecord(result) || result.ok !== true ||
    !isNonNegativeSafeInteger(result.revision)) throw invalidCanvasResponse(res)
  return result.revision
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
