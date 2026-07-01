const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export async function uploadAsset(file: File): Promise<string> {
  const res = await fetch(`${BASE}/assets`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  })
  if (!res.ok) throw new Error(`asset upload failed: ${res.status}`)
  const { assetId } = await res.json()
  return assetId as string
}

export function assetUrl(assetId: string): string {
  return `${BASE}/assets/${assetId}`
}
