import type { ChangeSet, Op } from '../src/model/changeset'
import type { CommentType } from '../src/model/types'
import type { CanvasDigest } from '../server/digest'
import { readCanvasDigest, postChangeSet, listProjects, type ProjectSummary } from './elvesClient'

export function makeChangeSet(ops: Op[]): ChangeSet {
  return { id: crypto.randomUUID(), author: 'claude', ops }
}

export function listProjectsTool(baseUrl: string): Promise<ProjectSummary[]> {
  return listProjects(baseUrl)
}

export function readCanvasTool(baseUrl: string, projectId: string): Promise<CanvasDigest> {
  return readCanvasDigest(baseUrl, projectId)
}

export function addCommentTool(
  baseUrl: string,
  projectId: string,
  args: { cardId: string; text: string; type?: CommentType | null },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'add_comment', cardId: args.cardId, comment: { type: args.type ?? null, text: args.text } },
  ]))
}

export function mergeSourcesTool(
  baseUrl: string,
  projectId: string,
  args: { cardIds: string[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'merge_sources', cardIds: args.cardIds }]))
}

export function moveCardsTool(
  baseUrl: string,
  projectId: string,
  args: { moves: { cardId: string; x: number; y: number }[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'move_cards', moves: args.moves }]))
}

export function createSourceCardTool(
  baseUrl: string,
  projectId: string,
  args: { text: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_source_card', text: args.text, x: args.x, y: args.y },
  ]))
}

export function createSectionTool(
  baseUrl: string,
  projectId: string,
  args: { text: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_section', text: args.text, x: args.x, y: args.y },
  ]))
}

export function moveSectionsTool(
  baseUrl: string,
  projectId: string,
  args: { moves: { sectionId: string; x: number; y: number }[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'move_sections', moves: args.moves }]))
}

export function editSectionTextTool(
  baseUrl: string,
  projectId: string,
  args: { sectionId: string; text: string },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'edit_section_text', sectionId: args.sectionId, text: args.text },
  ]))
}
