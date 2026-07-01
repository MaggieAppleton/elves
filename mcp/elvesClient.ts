import type { ChangeSet } from '../src/model/changeset'
import type { CardDigest } from '../server/digest'

export async function readCards(baseUrl: string): Promise<CardDigest[]> {
  const res = await fetch(`${baseUrl}/cards`)
  if (!res.ok) throw new Error(`read_canvas failed: ${res.status}`)
  return res.json() as Promise<CardDigest[]>
}

export async function postChangeSet(baseUrl: string, cs: ChangeSet): Promise<void> {
  const res = await fetch(`${baseUrl}/changeset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cs),
  })
  if (!res.ok) throw new Error(`change-set rejected: ${res.status}`)
}
