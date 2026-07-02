import type { APIRequestContext } from '@playwright/test'

// Defaults to the standard dev server; ELVES_E2E_BASE lets a run target an
// isolated server on another port (e.g. when the usual 5199 is already in use).
export const BASE = process.env.ELVES_E2E_BASE ?? 'http://localhost:5199'

/**
 * Ensure a single writing project exists and hand back its id, with an empty
 * canvas. The app opens the first project automatically, so after this the UI
 * lands directly on the canvas. Idempotent across tests (serial run): the first
 * call creates "E2E" (id `e2e`); later calls reuse it and just reset its canvas.
 */
export async function resetProject(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get(`${BASE}/projects`)).json()
  let id: string
  if (projects.length === 0) {
    const created = await request.post(`${BASE}/projects`, { data: { name: 'E2E' } })
    id = (await created.json()).id
  } else {
    id = projects[0].id
  }
  await request.post(`${BASE}/projects/${id}/canvas`, { data: { document: null, session: null } })
  return id
}

/** Card ids currently persisted on the server for a project (order as stored). */
export async function serverCardIds(request: APIRequestContext, projectId: string): Promise<string[]> {
  const snap = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records
    .filter((r: any) => r.typeName === 'shape' && r.type === 'card')
    .map((r: any) => r.id)
}
