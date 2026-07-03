import { Summarizer, NoopSummarizer } from './summarizer'
import { OllamaSummarizer } from './ollama'
import { OpenAISummarizer } from './openai'

export type { Summarizer } from './summarizer'
export { NoopSummarizer } from './summarizer'
export { OllamaSummarizer } from './ollama'
export { OpenAISummarizer } from './openai'
export { reconcileSummaries } from './reconcile'
export { reconcileCanvasFile } from './runner'

/**
 * Pick a summarizer backend from the environment. Local-first: defaults to
 * Ollama so a fresh install stays offline and free. `ELVES_SUMMARIZER=openai`
 * switches to the cloud mini backend; `=off` disables generation entirely.
 */
export function summarizerFromEnv(env: NodeJS.ProcessEnv = process.env): Summarizer {
  switch ((env.ELVES_SUMMARIZER ?? 'ollama').toLowerCase()) {
    case 'off':
    case 'none':
      return NoopSummarizer
    case 'openai':
      return new OpenAISummarizer()
    case 'ollama':
    default:
      return new OllamaSummarizer()
  }
}
