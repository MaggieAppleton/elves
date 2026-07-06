import type { APIRequestContext } from '@playwright/test'

// The API base MUST track the server Playwright actually started. Both this and
// playwright.config.ts key off ELVES_E2E_SERVER_PORT, so overriding the port
// moves the base to the same isolated server automatically — they can't diverge.
// (A run that set the port but not a hardcoded base once pointed resetProject at
// a real dev server on :5199 and blanked a real project.) ELVES_E2E_BASE still
// wins if a run needs to target something else explicitly.
const SERVER_PORT = process.env.ELVES_E2E_SERVER_PORT ?? '5199'
export const BASE = process.env.ELVES_E2E_BASE ?? `http://localhost:${SERVER_PORT}`

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
  // Clear via the explicit DELETE endpoint. Posting the empty sentinel would now
  // be refused (409) by the server's blank-canvas guard — clearing is a distinct,
  // intentional operation, which is exactly what a between-tests reset wants.
  await request.delete(`${BASE}/projects/${id}/canvas`)
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
