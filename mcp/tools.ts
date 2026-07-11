import type { ChangeSet, Op } from '../src/model/changeset'
import type { CommentType, Reference, RefType } from '../src/model/types'
import type { CardDigest, CardMap } from '../server/digest'
import type { ReadDraftBlock } from '../src/model/draft'
import { minimalReference } from '../server/unfurl'
import {
  readCardMap, readCards, readDraft, readSelection, postChangeSet, unfurlReference, listProjects,
  listReviews, postReview, postReviewStatus, type ProjectSummary, type SelectionResponse,
} from './elvesClient'
import {
  PERSONALITIES, composeBrief, type PersonalityId, type Review,
} from '../src/model/reviews'

/** Fields an agent may supply to override / enrich the unfurl baseline. */
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

export function readSelectionTool(baseUrl: string): Promise<SelectionResponse> {
  return readSelection(baseUrl)
}

export function addCommentTool(
  baseUrl: string,
  projectId: string,
  args: { cardId: string; text: string; type?: CommentType | null; reviewId?: string | null },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    {
      kind: 'add_comment',
      cardId: args.cardId,
      comment: { type: args.type ?? null, text: args.text, reviewId: args.reviewId ?? null },
    },
  ]))
}

export function listReviewsTool(baseUrl: string, projectId: string): Promise<Review[]> {
  return listReviews(baseUrl, projectId)
}

/** What start_review hands the claiming agent: the pass id to tag comments with, and its working brief. */
export interface StartedReview {
  reviewId: string
  personality: PersonalityId
  focus: string | null
  instructions: string
}

/**
 * Open a review pass and get its brief. Two entry paths, one record type:
 * - `reviewId` — claim a PENDING pass the user summoned from the review panel
 *   (moves it to in-progress under this process's agent id). Re-calling on a
 *   pass that is already in-progress just re-returns the brief, so a resumed
 *   agent can pick its pass back up without an illegal transition.
 * - `personality` — start an AD-HOC pass (the user asked in chat); the review
 *   record is created directly in-progress so the panel shows it like any other.
 */
export async function startReviewTool(
  baseUrl: string,
  projectId: string,
  args: { reviewId?: string; personality?: PersonalityId; focus?: string | null },
): Promise<StartedReview> {
  let review: Review
  if (args.reviewId) {
    const existing = (await listReviews(baseUrl, projectId)).find((r) => r.id === args.reviewId)
    if (!existing) throw new Error(`unknown review '${args.reviewId}' — call list_reviews to see valid ids`)
    review = existing.status === 'in-progress'
      ? existing
      : await postReviewStatus(baseUrl, projectId, existing.id, { status: 'in-progress', agent: agentId })
  } else if (args.personality) {
    review = await postReview(baseUrl, projectId, {
      personality: args.personality,
      focus: args.focus ?? null,
      agent: agentId,
    })
  } else {
    throw new Error('start_review needs a reviewId (a pending pass from list_reviews) or a personality (an ad-hoc pass)')
  }
  const personality = PERSONALITIES[review.personality]
  return {
    reviewId: review.id,
    personality: review.personality,
    focus: review.focus,
    instructions: composeBrief(personality, review.focus),
  }
}

export function completeReviewTool(
  baseUrl: string,
  projectId: string,
  args: { reviewId: string; verdict: string },
): Promise<Review> {
  return postReviewStatus(baseUrl, projectId, args.reviewId, { status: 'done', verdict: args.verdict })
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
 * fields the agent researched — those win for the fields it provides, the unfurl
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

/**
 * Create a figure card — a placeholder for a planned visual (illustration,
 * diagram, interactive animation) at its narrative position. `title` is a short
 * working title; `description` says what the visual needs to show, in words. The
 * card is born at status `idea` and carries this process's agent authorship mark,
 * since the agent is suggesting a placeholder the user refines or rejects. A figure
 * is a plan/annotation, never the user's prose — the safe side of the boundary,
 * like a section label.
 */
export function createFigureCardTool(
  baseUrl: string,
  projectId: string,
  args: { title: string; description: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'create_figure_card', title: args.title, description: args.description, x: args.x, y: args.y },
  ]))
}

/**
 * Edit the text of an existing WORKING-MATERIAL card — a note's body, a
 * reference's annotation, or a figure's description (via `text`), plus a figure's
 * working `title`. A prose card holds the user's own draft and the server refuses
 * to edit it (claudeMayEditCardText). `title` applies to figure cards only. Pass
 * only the field(s) you want to change.
 */
export function editCardTool(
  baseUrl: string,
  projectId: string,
  args: { cardId: string; text?: string; title?: string },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([
    { kind: 'edit_card', cardId: args.cardId, text: args.text, title: args.title },
  ]))
}

/**
 * Delete a card an agent authored — a suggestion it dropped (a figure, a note it
 * transcribed). The server restricts this to agent-authored cards, so it can
 * never remove the user's own prose or notes; those stay the user's to delete.
 */
export function deleteCardTool(
  baseUrl: string,
  projectId: string,
  args: { cardId: string },
): Promise<void> {
  return postChangeSet(baseUrl, projectId, makeChangeSet([{ kind: 'delete_card', cardId: args.cardId }]))
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
