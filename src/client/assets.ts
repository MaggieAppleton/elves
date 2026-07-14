import { useLayoutEffect, useRef } from 'react'
import { atom } from 'tldraw'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

// Elves shows one project at a time. assetUrl() is called deep inside the tldraw
// shape renderer where threading the project id as a prop is awkward. A tldraw
// atom keeps those tracked shape renderers live when App commits a project switch.
const assetProjectId = atom<string | null>('asset project id', null)
let assetProjectOwner: symbol | null = null
export function setAssetProject(projectId: string | null): void {
  assetProjectOwner = null
  assetProjectId.set(projectId)
}

function claimAssetProject(owner: symbol, projectId: string | null): void {
  assetProjectOwner = owner
  assetProjectId.set(projectId)
}

function releaseAssetProject(owner: symbol): void {
  if (assetProjectOwner !== owner) return
  assetProjectOwner = null
  assetProjectId.set(null)
}

/** Bind the module-level asset base to App's committed project lifecycle. */
export function useAssetProject(projectId: string | null): void {
  const ownerRef = useRef<symbol | null>(null)
  if (ownerRef.current === null) ownerRef.current = Symbol('asset project binding')
  const owner = ownerRef.current
  useLayoutEffect(() => {
    claimAssetProject(owner, projectId)
  }, [owner, projectId])
  useLayoutEffect(() => () => {
    releaseAssetProject(owner)
  }, [owner])
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
  const projectId = assetProjectId.get()
  if (!projectId) return ''
  return `${BASE}/projects/${encodeURIComponent(projectId)}/assets/${assetId}`
}
