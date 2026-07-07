import {
  CardKind, CardProps, Origin, Reference, CARD_DEFAULT_W, CARD_DEFAULT_H,
  REFERENCE_DEFAULT_W, REFERENCE_DEFAULT_H, FIGURE_DEFAULT_W, FIGURE_DEFAULT_H,
  AGENT_CARD_DEFAULT_W,
} from './types'

export { CARD_DEFAULT_W, CARD_DEFAULT_H, FIGURE_DEFAULT_W, FIGURE_DEFAULT_H, AGENT_CARD_DEFAULT_W }

// A summary is generated later (server-side, for long cards); a card is born
// without one. Keeping the four fields together keeps every factory honest.
const NO_SUMMARY = { summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null }

// Figure fields off by default. Only makeFigureCardProps overrides these; every
// other factory carries the "not a figure" defaults so all CardProps fields stay
// present and honest (an empty title, no status).
const NO_FIGURE = { figureTitle: '', figureStatus: null }

export function makeProseCardProps(text = ''): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'prose', noteKind: null, origin: null, text, authoredBy: null,
    comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null, ...NO_FIGURE, ...NO_SUMMARY,
  }
}

// An agent id (e.g. the changeset author) when an agent created the note through
// the MCP; null when a human made it. Renders as that agent's small logo mark.
export function makeNoteCardProps(text = '', origin: Origin = 'typed', authoredBy: string | null = null): CardProps {
  return {
    // Agent-added cards arrive wide (see AGENT_CARD_DEFAULT_W); hand-made ones stay small.
    w: authoredBy ? AGENT_CARD_DEFAULT_W : CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'note', noteKind: 'text', origin, text, authoredBy,
    comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null, ...NO_FIGURE, ...NO_SUMMARY,
  }
}

export function makeImageNoteCardProps(assetId: string): CardProps {
  return {
    w: 280, h: 200,
    kind: 'note', noteKind: 'image', origin: 'image', text: '', authoredBy: null,
    comments: [], mergedInto: null, draftExcluded: false, assetId, reference: null, ...NO_FIGURE, ...NO_SUMMARY,
  }
}

/**
 * A reference note card: structured bibliographic metadata (from unfurl or
 * an agent) with an empty annotation `text` the user fills in later. It is a
 * note card — reference material, never prose — so the boundary holds.
 */
export function makeReferenceCardProps(reference: Reference): CardProps {
  return {
    w: REFERENCE_DEFAULT_W, h: REFERENCE_DEFAULT_H,
    kind: 'note', noteKind: 'reference', origin: 'reference', text: '', authoredBy: null,
    comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference, ...NO_FIGURE, ...NO_SUMMARY,
  }
}

/**
 * A figure card: a placeholder for a planned visual, at its narrative position.
 * `title` is its short working title; `description` (stored in `text`) says what
 * the visual needs to show. It is born at status `idea`. Like a note or
 * reference card it can be agent-authored — an agent suggests a figure as a
 * placeholder the user refines or rejects — so `authoredBy` drives its
 * authorship mark. A figure's title + description are a plan/annotation, never
 * the user's prose, so an agent writing them stays on the safe side of the
 * boundary (see changeSetWritesText).
 */
export function makeFigureCardProps(
  title = '', description = '', authoredBy: string | null = null,
): CardProps {
  return {
    // Agent-suggested figures arrive wide (see AGENT_CARD_DEFAULT_W); hand-made ones stay small.
    w: authoredBy ? AGENT_CARD_DEFAULT_W : FIGURE_DEFAULT_W, h: FIGURE_DEFAULT_H,
    kind: 'figure', noteKind: null, origin: null, text: description, authoredBy,
    comments: [], mergedInto: null, draftExcluded: false, assetId: null, reference: null,
    figureTitle: title, figureStatus: 'idea', ...NO_SUMMARY,
  }
}

export function isProseCard(p: { kind: CardKind }): boolean {
  return p.kind === 'prose'
}

export function isNoteCard(p: { kind: CardKind }): boolean {
  return p.kind === 'note'
}

export function isFigureCard(p: { kind: CardKind }): boolean {
  return p.kind === 'figure'
}

/**
 * Elves' core rule, as testable code. The one card the user's OWN DRAFT lives in
 * — a prose card — is an agent's to organize, comment on, and question, but never
 * to write or edit. Everything else on the canvas is working material an agent
 * helps maintain: a note's body, a reference's annotation, a figure's
 * title/description. An agent may edit those (and the model already lets it *create*
 * them — see makeNoteCardProps / makeReferenceCardProps / makeFigureCardProps).
 * So the boundary is exactly one kind: prose is protected, the rest are editable.
 * The server tool API MUST consult this before applying any text edit attributed
 * to an agent (see edit_card in applyChangeSet).
 */
export function claudeMayEditCardText(kind: CardKind): boolean {
  return kind !== 'prose'
}
