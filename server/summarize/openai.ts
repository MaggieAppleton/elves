import { Summarizer, SUMMARY_PROMPT, cleanSummary } from './summarizer'

/**
 * Cloud summarizer via OpenAI's cheap mini models (default gpt-4o-mini). Opt-in
 * with ELVES_SUMMARIZER=openai + OPENAI_API_KEY. Effectively free at card
 * volume; the tradeoff vs Ollama is a network call and a key, not cost. An
 * Anthropic backend would be an identical shape (kept out of scope for now).
 */
export class OpenAISummarizer implements Summarizer {
  readonly label: string
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY ?? '',
    private readonly model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    private readonly timeoutMs = 20_000,
  ) {
    this.label = `openai/${this.model}`
  }

  async summarize(text: string): Promise<string | null> {
    if (!this.apiKey) return null
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [{ role: 'user', content: SUMMARY_PROMPT + text }],
        }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
      const content = body.choices?.[0]?.message?.content
      return typeof content === 'string' ? cleanSummary(content) : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
