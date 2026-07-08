/**
 * Who wrote a section's current label: the literal `'user'` for a human, or an
 * agent id (e.g. `'claude'`, `'codex'`) for one authored through the MCP. An open
 * string, not a fixed union, so any agent (see ELVES_AGENT) stamps its own id,
 * which the agent registry resolves to the section's accent and authorship mark.
 */
export type SectionAuthor = string

export interface SectionProps {
  w: number
  h: number
  /** A short thematic label. Unlike card text, either the user or an agent may write this. */
  text: string
  /** Author of the CURRENT text — flips whenever the text changes, from either side. */
  authoredBy: SectionAuthor
}

export const SECTION_DEFAULT_W = 320
export const SECTION_DEFAULT_H = 72

// The prompt shown in an as-yet-unnamed section header. Shared between the
// editing textarea (SectionShapeUtil) and the autosizer (autosize.ts) so a
// blank header is sized to hold the whole prompt rather than clipping to a
// thin sliver.
export const SECTION_PLACEHOLDER = 'Section name'

export function makeSectionProps(text = '', authoredBy: SectionAuthor = 'user'): SectionProps {
  return { w: SECTION_DEFAULT_W, h: SECTION_DEFAULT_H, text, authoredBy }
}
