import type { Project } from './persistence'

export type CanvasRenameAmbiguousReason =
  | 'invalid-project-list'
  | 'identity-match-count'
  | 'unknown-state'

export type CanvasRenameOutcome =
  | { kind: 'committed'; project: Project }
  | { kind: 'rolled-back'; project: Project }
  | { kind: 'partial-move'; project: Project }
  | { kind: 'ambiguous'; reason: CanvasRenameAmbiguousReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidProject(value: unknown): value is Project {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    typeof value.createdAt === 'string' && value.createdAt.trim().length > 0
}

export function validRenameResult(
  value: unknown,
  original: Project,
  requestedName: string,
): Project | null {
  if (!isValidProject(value) || value.createdAt !== original.createdAt ||
    value.name !== requestedName) return null
  return value
}

export function classifyCanvasRenameOutcome(
  value: unknown,
  original: Project,
  requestedName: string,
): CanvasRenameOutcome {
  if (!Array.isArray(value) || !value.every(isValidProject)) {
    return { kind: 'ambiguous', reason: 'invalid-project-list' }
  }
  const matches = value.filter((project) => project.createdAt === original.createdAt)
  if (matches.length !== 1) {
    return { kind: 'ambiguous', reason: 'identity-match-count' }
  }
  const [project] = matches
  if (project.name === requestedName) return { kind: 'committed', project }
  if (project.id === original.id && project.name === original.name) {
    return { kind: 'rolled-back', project }
  }
  if (project.id !== original.id && project.name === original.name) {
    return { kind: 'partial-move', project }
  }
  return { kind: 'ambiguous', reason: 'unknown-state' }
}
