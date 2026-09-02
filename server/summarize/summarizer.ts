/**
 * The one impure, possibly-networked operation in an otherwise local app:
 * turning a long card's text into a one-phrase gist. The Ollama backend
 * implements this narrow interface, keeping the network call isolated behind it.
 * Any failure returns null — the caller then leaves the card's summary absent
 * and consumers fall back to a mechanical gist, so nothing ever breaks when the
 * model is unreachable.
 */
export interface Summarizer {
  summarize(text: string): Promise<string | null>
  /** Provenance stamp stored on the card, e.g. 'ollama/llama3.2'. */
  readonly label: string
}

/**
 * The instruction every backend sends. Kept here so backends stay identical.
 *
 * The vocabulary ban is the house style (src/model/houseStyle.ts) cut down to
 * what a small local model can actually hold: a gist is twelve words shown on
 * every zoomed-out card, so the only slop that fits is a single inflated word,
 * and naming the words outright works better here than a page of principles.
 * A gist is generated, not written through a tool, so nothing rejects it —
 * this prompt is the only lever.
 */
export const SUMMARY_PROMPT =
  'Summarize this note in one short phrase of at most 12 words. ' +
  'Reply with only the phrase — no preamble, no quotation marks, no trailing period. ' +
  'Use plain, concrete words from the note itself. Never use: delve, tapestry, ' +
  'intricate, interplay, underscore, pivotal, crucial, seamless, nuanced, robust, ' +
  'multifaceted, leverage, holistic, realm, landscape, or "explores the".\n\nNote:\n'

/** Tidy a raw model reply into a single clean phrase. */
export function cleanSummary(raw: string): string | null {
  const line = raw.trim().split('\n')[0].trim().replace(/^["'“]|["'”.]$/g, '').trim()
  return line.length ? line : null
}
