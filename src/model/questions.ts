/**
 * Question cards — an editor's sticky note. Claude (or another agent) drops a
 * short, pointed question near the cluster it's about; the user answers by
 * writing their OWN cards beside it, then dismisses it. A question never carries
 * draft prose — only a question — so it stays on the safe side of the "only I
 * write the final prose" rule, like a comment or a section label.
 *
 * Modelled like a section (a bare shape with text + author, no comments/merge),
 * but its authorship follows the CARD model: `authoredBy` is an open agent id
 * (e.g. 'claude'), resolved through the agent registry to an accent + logomark,
 * so a question is always visibly agent-authored and a second agent can drop its
 * own. Questions are never user-authored (you'd just write a note card).
 */
export interface QuestionProps {
  w: number
  h: number
  /** The question text. Always agent-authored; the user never edits it. */
  text: string
  /** Agent id that asked it (drives the accent + authorship mark). */
  authoredBy: string
  /** Dismissed by the user once answered (or waved off). Hidden but recoverable
   * in-file — never deleted, so Claude still sees it in read_map and won't re-ask. */
  dismissed: boolean
}

export const QUESTION_DEFAULT_W = 220
export const QUESTION_DEFAULT_H = 96

export function makeQuestionProps(
  text = '',
  authoredBy = 'claude',
  dismissed = false,
): QuestionProps {
  return { w: QUESTION_DEFAULT_W, h: QUESTION_DEFAULT_H, text, authoredBy, dismissed }
}
