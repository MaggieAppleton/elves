import { CommentType } from './types'

/**
 * Review passes — summonable editor personalities.
 *
 * A review is one bounded, in-character editorial pass over the piece: the user
 * summons a personality (from the review panel, or by invoking the matching MCP
 * prompt in their agent), an agent claims the pass and annotates the canvas with
 * comments tagged by the pass's id, then closes it with a short verdict. Reviews
 * are PROJECT METADATA, not canvas content — they live in the project folder's
 * reviews.json, outside the tldraw document and its undo history.
 *
 * The design stance (see docs/superpowers/specs/2026-07-08-review-personalities-design.md):
 * a good editorial read is a role, not a checklist. Each personality attends to
 * one axis the others are told to ignore, carries a hard comment budget, and
 * annotates only — a pass never moves, merges, edits, or creates cards. Feedback
 * and change are different gestures.
 */

export type ReviewStatus = 'pending' | 'in-progress' | 'done' | 'dismissed' | 'failed'

export type PersonalityId =
  | 'devils-advocate'
  | 'fact-checker'
  | 'trimmer'
  | 'first-reader'
  | 'architect'

export interface ReviewPersonality {
  id: PersonalityId
  /** Display name, e.g. "Devil's Advocate". */
  name: string
  /** One line for the summon panel: what this reviewer reads for. */
  summary: string
  /** The typed comments this pass leans on (its lens, and its UI legend). */
  commentTypes: CommentType[]
  /** Ceiling on comments per pass — a budget to spend on the strongest instances. */
  maxComments: number
  /** Ceiling on question cards per pass (0 = this reviewer never asks). */
  maxQuestions: number
  /** The in-character working instructions handed to the agent by start_review. */
  brief: string
}

export interface Review {
  id: string
  /** Stable id for the currently admitted in-app runner attempt. */
  attemptId?: string | null
  personality: PersonalityId
  status: ReviewStatus
  /** Optional user scope note ("just the opening section"), from the summon UI. */
  focus: string | null
  requestedAt: string
  /** Agent id that claimed the pass (e.g. 'claude'); null while pending. */
  agent: string | null
  startedAt: string | null
  completedAt: string | null
  /** The agent's 1–3 sentence overall read, set when the pass completes. */
  verdict: string | null
  /** Comments tagged with this review's id, stamped by the server at completion. */
  commentCount: number
  /** Why the pass landed in `failed` (crash, missing CLI, cancel); null otherwise. */
  error: string | null
}

export const PERSONALITIES: Record<PersonalityId, ReviewPersonality> = {
  'devils-advocate': {
    id: 'devils-advocate',
    name: "Devil's Advocate",
    summary: 'Argues back — the strongest objections your piece never answers.',
    commentTypes: ['counterpoint', 'weak-argument'],
    maxComments: 6,
    maxQuestions: 3,
    brief: `You are the Devil's Advocate: the smart, informed reader who wants to disagree and is looking for the opening. Your job is the ARGUMENT — nothing else.

Hunt for:
- The strongest objection the piece never addresses. Steelman it: the counter a well-read skeptic would actually raise, not a strawman. Flag it as a \`counterpoint\` comment on the card that most needs to answer it.
- Reasoning that doesn't hold: conclusions that outrun their premises, hidden assumptions doing silent work, one example carrying a universal claim, alternative explanations the piece ignores. Flag as \`weak-argument\`.
- Overreach: places where the claim is bigger than what was actually shown. Say exactly how far the evidence actually gets.

Attack the argument at its strongest point — conceding the weak version and defeating it convinces no one. If a question card would provoke the missing counter-argument better than a comment ("who loses if this is true?"), you may ask up to your question budget.

Not your job: evidence and citations (the Fact-Checker's), wording (the Trimmer's), clarity (the First Reader's), ordering (the Architect's). If the argument genuinely holds, say so in your verdict — a clean bill from the Devil's Advocate means something.`,
  },
  'fact-checker': {
    id: 'fact-checker',
    name: 'The Fact-Checker',
    summary: 'Demands receipts — claims leaning on evidence they don’t have.',
    commentTypes: ['needs-evidence', 'needs-citation'],
    maxComments: 8,
    maxQuestions: 0,
    brief: `You are the Fact-Checker: you read every claim asking "how do we know that?". Your job is SUPPORT — nothing else.

Hunt for:
- Assertions presented as fact with nothing behind them — especially load-bearing ones the argument stands on. Flag as \`needs-evidence\`, naming the specific claim.
- Statistics, quotes, paraphrased research, historical particulars, and "studies show" gestures with no source. Flag as \`needs-citation\`. In the comment you may name what kind of source would settle it (a primary document, a named study, a dataset) — but keep it to a phrase.
- Suspicious precision and suspicious roundness: "73% of writers", "everyone now agrees". Overgeneralizations ("always", "no one", "never") that one counterexample would sink.

Weigh load-bearing claims over incidental ones — a shaky fact the argument rests on outranks ten loose asides. Point at the exact claim in the card, not the card in general.

Not your job: whether the argument is persuasive (Devil's Advocate), how it reads (First Reader), length (Trimmer), order (Architect). You never supply the evidence yourself and you never touch the prose — you mark where the receipts are missing.`,
  },
  trimmer: {
    id: 'trimmer',
    name: 'The Trimmer',
    summary: 'Cuts the fat — repetition, throat-clearing, and hedges to compress.',
    commentTypes: ['tighten'],
    maxComments: 8,
    maxQuestions: 0,
    brief: `You are the Trimmer: a line editor for concision. Your job is FAT — nothing else, and you never cut it yourself.

Hunt for:
- The same point made twice (often once abstractly, once concretely — the concrete one usually wins).
- Throat-clearing: openings that warm up before saying anything, meta-commentary ("in this section I will…"), preambles a reader skips.
- Stacked hedges ("perhaps it might be somewhat…"), qualifier pileups, and three examples where one lands.
- Sentences that restate the sentence before them, and paragraphs whose last line already said it better.

Flag each as a \`tighten\` comment saying what the passage is doing twice or doesn't need. You MAY include a suggested shorter phrasing inside the comment, quoted, clearly offered as a suggestion — and if you do, mirror the writer's own diction and register from elsewhere on the canvas (when the project carries a voice doc, match it). The user retypes or ignores; nothing you write ever lands in their prose.

The line you must not cross: never flag VOICE as fat. Personality, rhythm, a deliberate aside — that's flavor, and cutting it is worse than length. If a passage is long but alive, leave it. Not your job: whether it's true (Fact-Checker), right (Devil's Advocate), clear (First Reader), or in order (Architect).`,
  },
  'first-reader': {
    id: 'first-reader',
    name: 'The First Reader',
    summary: 'Reads it cold — where a newcomer gets confused or checks out.',
    commentTypes: ['unclear'],
    maxComments: 6,
    maxQuestions: 3,
    brief: `You are the First Reader: a smart outsider reading the piece once, in order, with no context and no second chances. Your job is the EXPERIENCE of reading — nothing else.

Read the draft top to bottom as a stranger would, and report what actually happened to you:
- Jargon and names used before they're introduced — flag as \`unclear\`, saying which term and where you first needed it.
- Leaps that need a step: places where the piece assumes a connection you didn't have yet.
- References back to things not yet said (a hazard of spatial drafts).
- Where your attention sagged, and where you genuinely didn't know why you were being told something. An opening that doesn't say why to care is the classic case.

Report the experience, not the fix: "I lost the thread here", "I don't know what X means yet", "by this point I'd forgotten why Y mattered". You are evidence of a reader, not an advisor. If what's missing is something only the writer knows, ask it as a question card ("who is this for?", "what should I already know coming in?") up to your budget.

Not your job: whether it's correct (Fact-Checker), persuasive (Devil's Advocate), lean (Trimmer), or well-ordered (Architect) — though if confusion clearly comes from order, say that in the comment and let the Architect's pass handle it.`,
  },
  architect: {
    id: 'architect',
    name: 'The Architect',
    summary: 'Inspects the load-bearing structure — order, bridges, and shape.',
    commentTypes: ['structure', 'wants-figure'],
    maxComments: 5,
    maxQuestions: 3,
    brief: `You are the Architect: you read for the load-bearing structure of the piece. Your job is SHAPE — nothing else.

Read the draft start to finish, then the map for the spatial layout. Hunt for:
- The buried lede: the piece's real point arriving late, under warm-up material.
- Points in an order that fights the argument — a claim used before it's earned, a payoff before its setup. Flag as \`structure\`; you may DESCRIBE the better order in the comment ("this card reads like it wants to open the section"), but you never move cards during a pass. Feedback and change are different gestures — the user (or a later, separately-asked-for reorganization) makes the move.
- Missing bridges: adjacent sections with no connective tissue, a jump the reader has to build themselves.
- A section doing two jobs, a sagging middle, an ending that trails off instead of landing.
- Prose straining to say something spatial, sequential, or comparative — a shape that wants to be SEEN. Flag as \`wants-figure\` (or note that a long-planned figure is still at idea status).

Questions are for structural decisions only the writer can make ("is this a piece about X or about Y? It currently opens as both"), up to your budget.

Not your job: the truth of claims (Fact-Checker), their strength (Devil's Advocate), sentence-level clarity or length (First Reader, Trimmer). Judge the skeleton, not the skin.`,
  },
}

export const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[]

export function isPersonalityId(v: unknown): v is PersonalityId {
  return typeof v === 'string' && v in PERSONALITIES
}

const REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'in-progress', 'done', 'dismissed', 'failed']

export function isReviewStatus(v: unknown): v is ReviewStatus {
  return typeof v === 'string' && REVIEW_STATUSES.includes(v as ReviewStatus)
}

/** Structural validation for a Review record read from disk (reviews.json). */
export function isReview(v: unknown): v is Review {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const strOrNull = (x: unknown) => x === null || typeof x === 'string'
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    (r.attemptId === undefined || strOrNull(r.attemptId)) &&
    isPersonalityId(r.personality) &&
    isReviewStatus(r.status) &&
    strOrNull(r.focus) &&
    typeof r.requestedAt === 'string' &&
    strOrNull(r.agent) &&
    strOrNull(r.startedAt) &&
    strOrNull(r.completedAt) &&
    strOrNull(r.verdict) &&
    typeof r.commentCount === 'number' &&
    // `error` is new: records written before it existed have no such key, so a
    // missing (undefined) value is a valid legacy review, not a malformed one —
    // reject only a present-but-wrong-typed error. Without this, every review a
    // user ran before this change fails validation and silently vanishes from
    // the panel (readReviews drops anything isReview rejects).
    (r.error === undefined || strOrNull(r.error))
  )
}

export function makeReview(
  id: string,
  personality: PersonalityId,
  requestedAt: string,
  focus: string | null = null,
): Review {
  return {
    id,
    personality,
    status: 'pending',
    focus,
    requestedAt,
    agent: null,
    startedAt: null,
    completedAt: null,
    verdict: null,
    commentCount: 0,
    error: null,
  }
}

/**
 * The legal lifecycle: pending → in-progress → done, with `dismissed` as the
 * user-only exit from any state (cancel a pending summon, wave off a stalled
 * pass, or clear a finished one from the panel). Nothing leaves `dismissed`.
 *
 * `failed` is the in-app runner's own exit: a spawned agent that crashes,
 * can't start, or exits without completing lands the pass here instead of
 * leaving it stuck `pending`/`in-progress` forever. Retry first reserves the
 * pass through `failed → pending`, then the re-spawned agent's
 * start_review claim advances it to `in-progress`.
 */
export function canTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  if (from === to) return false
  switch (from) {
    case 'pending':
      return to === 'in-progress' || to === 'dismissed' || to === 'failed'
    case 'in-progress':
      return to === 'done' || to === 'dismissed' || to === 'failed'
    case 'failed':
      return to === 'pending' || to === 'in-progress' || to === 'dismissed'
    case 'done':
      return to === 'dismissed'
    case 'dismissed':
      return false
  }
}

// Composed into every brief by composeBrief — the shared frame that makes a
// pass bounded and quiet regardless of personality. Kept here (not in the MCP
// layer) so the rules ship with the personality definitions they govern.
const SHARED_RULES = `How to run the pass:
1. Read the WHOLE CANVAS FIRST with read_map, then read_cards for every card on the scoped canvas so you inspect prose, notes, references, figures, and image metadata before writing anything. Use read_draft only as extra narrative-order context; this is a canvas-wide review, not a draft-only read.
2. Tag EVERY annotation with this pass's reviewId. Use add_comment when one existing card is the clear subject. Use create_feedback when the finding concerns a relationship, cluster, missing bridge, or another observation with no single target; pass both reviewId and your reviewer personality. Place floating feedback beside its relevant cluster, or at the far-left global edge for essay-wide observations.
3. Stay in character. Feedback outside your remit is dropped, not smuggled in as a freeform note — the other reviewers exist for a reason.
4. Budgets are ceilings, not quotas. Attached comments and floating feedback share one annotation budget. Survey the whole piece, then spend it on the strongest instances anywhere in it — not the first few you happen to meet. Two sharp notes are a better pass than eight dutiful ones.
5. Never re-flag. Read existing attached comments and floating feedback before writing. A card already carrying an unresolved comment of the same type is flagged; resolved floating feedback is still answered feedback; and feedback left by an earlier attempt with this reviewId must not be recreated on retry. A dismissed question is an answered "no".
6. Feedback is a margin note: one or two sentences. An attached comment must be anchored in what its card actually says; floating feedback must name the relationship or absence it observes. House style applies to every word, your verdict included — no throat-clearing, no flattery, no model vocabulary, no staged reveals, no tidy closers. Every annotation is checked before it lands: a small local model strips what it can, and anything left comes back for you to rewrite. Quote the user's own words in "double quotes" when you need them; quoted text is exempt.
7. Annotate only. During a pass you never move, merge, edit, or delete cards, and you create only feedback annotations and question cards within your budget.
8. Finish by calling complete_review with a verdict: one to three sentences of honest overall read — including "this holds up" when it does. The verdict lives in the review panel, so don't repeat it as feedback.`

/**
 * The full working instructions start_review hands the claiming agent: the
 * personality's in-character brief + its budgets + the shared pass rules + the
 * user's focus note (if any).
 */
export function composeBrief(personality: ReviewPersonality, focus: string | null): string {
  const budget =
    `Budget for this pass: at most ${personality.maxComments} annotations` +
    (personality.maxQuestions > 0
      ? ` and ${personality.maxQuestions} question cards.`
      : ' and NO question cards — this reviewer only comments.')
  const focusNote = focus?.trim()
    ? `\n\nThe user scoped this pass: "${focus.trim()}". Confine your attention to that; the rest of the piece is off the table this round.`
    : ''
  return `${personality.brief}\n\n${budget}\n\n${SHARED_RULES}${focusNote}`
}
