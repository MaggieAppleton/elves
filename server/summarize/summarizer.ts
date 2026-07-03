/**
 * The one impure, possibly-networked operation in an otherwise local app:
 * turning a long card's text into a one-phrase gist. Every backend implements
 * this narrow interface, so the model is a swappable config choice, not a
 * decision baked into the server. Any failure returns null — the caller then
 * leaves the card's summary absent and consumers fall back to a mechanical
 * gist, so nothing ever breaks when no model is reachable.
 */
export interface Summarizer {
  summarize(text: string): Promise<string | null>
  /** Provenance stamp stored on the card, e.g. 'ollama/llama3.2'. */
  readonly label: string
}

/** The instruction every backend sends. Kept here so backends stay identical. */
export const SUMMARY_PROMPT =
  'Summarize this note in one short phrase of at most 12 words. ' +
  'Reply with only the phrase — no preamble, no quotation marks, no trailing period.\n\nNote:\n'

/** Tidy a raw model reply into a single clean phrase. */
export function cleanSummary(raw: string): string | null {
  const line = raw.trim().split('\n')[0].trim().replace(/^["'“]|["'”.]$/g, '').trim()
  return line.length ? line : null
}

/**
 * The always-off backend: the fallback when summarization is disabled or no
 * model is configured, and the default in tests so suites stay offline.
 */
export const NoopSummarizer: Summarizer = {
  label: 'none',
  async summarize() {
    return null
  },
}
