import { Summarizer, SUMMARY_PROMPT, cleanSummary } from './summarizer'

/**
 * Local-first summarizer via Ollama (https://ollama.com). Keeps Elves offline
 * and free: no key, no data leaving the machine. If Ollama isn't running or the
 * model isn't pulled, every call returns null and the app degrades to mechanical
 * gists — the feature is additive, never load-bearing.
 */
export class OllamaSummarizer implements Summarizer {
  readonly label: string
  private readonly active = new Set<AbortController>()
  private closed = false
  constructor(
    private readonly host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    private readonly model = process.env.OLLAMA_MODEL ?? 'llama3.2',
    private readonly timeoutMs = 20_000,
  ) {
    this.label = `ollama/${this.model}`
  }

  async summarize(text: string): Promise<string | null> {
    if (this.closed) return null
    const ctrl = new AbortController()
    this.active.add(ctrl)
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: this.model,
          prompt: SUMMARY_PROMPT + text,
          stream: false,
          options: { temperature: 0 },
        }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { response?: unknown }
      return typeof body.response === 'string' ? cleanSummary(body.response) : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      this.active.delete(ctrl)
    }
  }

  close(): void {
    this.closed = true
    for (const controller of this.active) controller.abort()
  }
}
