import { Summarizer, NoopSummarizer } from './summarizer'
import { OllamaSummarizer } from './ollama'

export type { Summarizer } from './summarizer'
export { NoopSummarizer } from './summarizer'
export { OllamaSummarizer } from './ollama'
export { reconcileSummaries } from './reconcile'
export { reconcileCanvasFile } from './runner'

/**
 * Pick a summarizer backend from the environment. Local-first and Ollama-only:
 * summaries are generated on-machine via Ollama, or not at all. Set
 * `ELVES_SUMMARIZER=off` to disable generation entirely.
 */
export function summarizerFromEnv(env: NodeJS.ProcessEnv = process.env): Summarizer {
  switch ((env.ELVES_SUMMARIZER ?? 'ollama').toLowerCase()) {
    case 'off':
    case 'none':
      return NoopSummarizer
    case 'ollama':
    default:
      return new OllamaSummarizer()
  }
}
