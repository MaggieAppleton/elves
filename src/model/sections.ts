export type SectionAuthor = 'user' | 'claude'

export interface SectionProps {
  w: number
  h: number
  /** A short thematic label. Unlike card text, either the user or Claude may write this. */
  text: string
  /** Author of the CURRENT text — flips whenever the text changes, from either side. */
  authoredBy: SectionAuthor
}

export const SECTION_DEFAULT_W = 320
export const SECTION_DEFAULT_H = 72

export function makeSectionProps(text = '', authoredBy: SectionAuthor = 'user'): SectionProps {
  return { w: SECTION_DEFAULT_W, h: SECTION_DEFAULT_H, text, authoredBy }
}
