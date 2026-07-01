const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export async function loadCanvas(): Promise<any> {
  const res = await fetch(`${BASE}/canvas`)
  if (!res.ok) throw new Error(`load failed: ${res.status}`)
  return res.json()
}

export async function saveCanvas(snapshot: unknown): Promise<void> {
  const res = await fetch(`${BASE}/canvas`, {
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
