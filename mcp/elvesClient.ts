import type { ChangeSet } from '../src/model/changeset'
import type { CardDigest, CardMap } from '../server/digest'
import type { Project } from '../server/projects'
import type { Reference } from '../src/model/types'
import type { ReadDraftBlock } from '../src/model/draft'
import type { SelectedShape } from '../server/selection'

export type ProjectSummary = Pick<Project, 'id' | 'name'>

/** The user's current canvas selection. `project`/`selectedAt` are absent when
 * nothing is selected yet (or the selected project is gone) — `selection` is
 * then an empty array. */
export interface SelectionResponse {
  project?: string
  selection: SelectedShape[]
  selectedAt?: string
}

export async function listProjects(baseUrl: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${baseUrl}/projects`)
  if (!res.ok) throw new Error(`list_projects failed: ${res.status}`)
  const projects = (await res.json()) as Project[]
  return projects.map((p) => ({ id: p.id, name: p.name }))
}

export async function readCardMap(baseUrl: string, projectId: string): Promise<CardMap> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/map`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_map failed: ${res.status}`)
  return res.json() as Promise<CardMap>
}

export async function readSelection(baseUrl: string): Promise<SelectionResponse> {
  const res = await fetch(`${baseUrl}/selection`)
  if (!res.ok) throw new Error(`read_selection failed: ${res.status}`)
  return res.json() as Promise<SelectionResponse>
}

export async function readDraft(baseUrl: string, projectId: string): Promise<ReadDraftBlock[]> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/draft`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_draft failed: ${res.status}`)
  const { blocks } = (await res.json()) as { blocks: ReadDraftBlock[] }
  return blocks
}

export async function readCards(
  baseUrl: string,
  projectId: string,
  ids: string[],
): Promise<CardDigest[]> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_cards failed: ${res.status}`)
  const { cards } = (await res.json()) as { cards: CardDigest[] }
  return cards
}

export async function unfurlReference(
  baseUrl: string,
  projectId: string,
  url: string,
): Promise<Reference> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/unfurl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`unfurl failed: ${res.status}`)
  const { reference } = (await res.json()) as { reference: Reference }
  return reference
}

export async function postChangeSet(
  baseUrl: string,
  projectId: string,
  cs: ChangeSet,
): Promise<void> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/changeset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cs),
  })
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`change-set rejected: ${res.status} ${body}`.trim())
  }
}
