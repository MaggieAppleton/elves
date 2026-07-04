import type { ChangeSet, Op } from '../src/model/changeset'
import type { CommentType, Reference, RefType } from '../src/model/types'
import type { CardDigest, CardMap } from '../server/digest'
import type { ReadDraftBlock } from '../src/model/draft'
import { minimalReference } from '../server/unfurl'
import {
  readCardMap, readCards, readDraft, postChangeSet, unfurlReference, listProjects, type ProjectSummary,
} from './elvesClient'

/** Fields Claude may supply to override / enrich the unfurl baseline. */
export interface ReferenceFields {
  refType?: RefType
  title?: string
  authors?: string[]
  year?: number
  venue?: string
  description?: string
  siteName?: string
  doi?: string
}

// The agent id stamped on every change-set this process posts, and thus onto
// note cards it creates (their authorship mark). A single MCP process speaks for
// exactly one agent, so process-wide config models reality faithfully: set it
// once at startup from ELVES_AGENT (see mcp/index.ts). Defaults to 'claude'.
let agentId = 'claude'

export function setAgentId(id: string): void {
  if (id) agentId = id
}

export function getAgentId(): string {
  return agentId
}

export function makeChangeSet(ops: Op[], author: string = agentId): ChangeSet {
  return { id: crypto.randomUUID(), author, ops }
}

export function listProjectsTool(baseUrl: string): Promise<ProjectSummary[]> {
  return listProjects(baseUrl)
}

export function readMapTool(baseUrl: string, projectId: string): Promise<CardMap> {
  return readCardMap(baseUrl, projectId)
}

export function readCardsTool(
  baseUrl: string,
  projectId: string,
  cardIds: string[],
): Promise<CardDigest[]> {
  return readCards(baseUrl, projectId, cardIds)
}

export function readDraftTool(baseUrl: string, projectId: string): Promise<ReadDraftBlock[]> {
  return readDraft(baseUrl, projectId)
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

export function mergeNotesTool(
  baseUrl: string,
  projectId: string,
  args: { cardIds: string[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'merge_notes', cardIds: args.cardIds }]))
}

export function moveCardsTool(
  baseUrl: string,
  projectId: string,
  args: { moves: { cardId: string; x: number; y: number }[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'move_cards', moves: args.moves }]))
}

export function createNoteCardTool(
  baseUrl: string,
  projectId: string,
  args: { text: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_note_card', text: args.text, x: args.x, y: args.y },
  ]))
}

/**
 * Create a reference note card. Fetches an unfurl baseline for the url
 * (title/site/favicon/hero, and citation metadata for papers), then overlays any
 * fields Claude researched — Claude wins for the fields it provides, the unfurl
 * baseline fills the rest (and keeps the locally-cached favicon/thumbnail). If
 * the page can't be fetched, falls back to a minimal reference so a card still
 * lands. Writes only reference *facts* + a new note card — never prose.
 */
export async function createReferenceTool(
  baseUrl: string,
  projectId: string,
  args: { url: string; x: number; y: number; fields?: ReferenceFields },
): Promise<void> {
  const f = args.fields ?? {}
  let base: Reference
  try {
    base = await unfurlReference(baseUrl, projectId, args.url)
  } catch {
    base = minimalReference(args.url, new Date().toISOString(), f.refType)
  }
  const claudeProvided = Object.values(f).some((v) => v !== undefined)
  const reference: Reference = {
    ...base,
    url: args.url,
    refType: f.refType ?? base.refType,
    title: f.title ?? base.title,
    authors: f.authors && f.authors.length ? f.authors : base.authors,
    year: f.year ?? base.year,
    venue: f.venue ?? base.venue,
    description: f.description ?? base.description,
    siteName: f.siteName ?? base.siteName,
    doi: f.doi ?? base.doi,
    fetchedBy: claudeProvided ? 'claude' : base.fetchedBy,
  }
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_reference', reference, x: args.x, y: args.y },
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

export function createQuestionTool(
  baseUrl: string,
  projectId: string,
  args: { text: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_question', text: args.text, x: args.x, y: args.y },
  ]))
}

export function groupCardsTool(
  baseUrl: string,
  projectId: string,
  args: { cardIds: string[] },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'group_cards', cardIds: args.cardIds }]))
}

export function ungroupCardsTool(
  baseUrl: string,
  projectId: string,
  args: { groupId: string },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'ungroup_cards', groupId: args.groupId }]))
}
