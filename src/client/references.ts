import type { Reference } from '../model/types'
import { blankReference } from '../model/references'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

/**
 * Ask the server to unfurl a url into a Reference (fetching its metadata +
 * caching favicon/hero as local assets). This is an explicit, user-initiated
 * fetch of a public url — the canvas itself never leaves the machine. If the
 * server is unreachable we still return a usable bare reference so a card lands.
 */
export async function requestUnfurl(projectId: string, url: string): Promise<Reference> {
  try {
    const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/unfurl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) throw new Error(`unfurl failed: ${res.status}`)
    const { reference } = (await res.json()) as { reference: Reference }
    return reference
  } catch {
    return blankReference(url, new Date().toISOString(), undefined, 'user')
  }
}
