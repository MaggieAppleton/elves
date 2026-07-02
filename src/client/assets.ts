const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

// Elves shows one project at a time. assetUrl() is called deep inside the tldraw
// shape renderer where threading the project id as a prop is awkward, so App sets
// the active project here whenever it opens/switches a project.
let assetProjectId: string | null = null
export function setAssetProject(projectId: string | null): void {
  assetProjectId = projectId
}

export async function uploadAsset(projectId: string, file: File): Promise<string> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/assets`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  })
  if (!res.ok) throw new Error(`asset upload failed: ${res.status}`)
  const { assetId } = await res.json()
  return assetId as string
}

export function assetUrl(assetId: string): string {
  if (!assetProjectId) return ''
  return `${BASE}/projects/${encodeURIComponent(assetProjectId)}/assets/${assetId}`
}
