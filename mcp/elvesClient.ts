import type { ChangeSet } from '../src/model/changeset'
import type { CanvasDigest } from '../server/digest'
import type { Project } from '../server/projects'

export type ProjectSummary = Pick<Project, 'id' | 'name'>

export async function listProjects(baseUrl: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${baseUrl}/projects`)
  if (!res.ok) throw new Error(`list_projects failed: ${res.status}`)
  const projects = (await res.json()) as Project[]
  return projects.map((p) => ({ id: p.id, name: p.name }))
}

export async function readCanvasDigest(baseUrl: string, projectId: string): Promise<CanvasDigest> {
  const res = await fetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}/canvas-digest`)
  if (res.status === 404) throw new Error(`unknown project '${projectId}' — call list_projects to see valid ids`)
  if (!res.ok) throw new Error(`read_canvas failed: ${res.status}`)
  return res.json() as Promise<CanvasDigest>
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
