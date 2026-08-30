/**
 * The one place that knows how to ask a local model for a completion.
 *
 * Elves talks to Ollama from three places now — card gists
 * (server/summarize/ollama.ts), repairing an agent's note before it lands on
 * the canvas (mcp/repair.ts), and repairing an agent's chat reply before it is
 * saved (server/replyStyle.ts). Each owns its own prompt, timeout and
 * acceptance policy, because those differ sharply; all three want the same
 * twenty lines of transport.
 *
 * Deliberately dependency-free so either process can import it: the MCP server
 * runs as its own `tsx mcp/index.ts` process and pulls nothing else in from
 * server/ by doing so.
 *
 * Never throws. A local model is a convenience in this app, never a
 * dependency — Ollama not installed, not running, model not pulled, request
 * too slow all return null, and every caller has a defined answer for null.
 */
export interface OllamaRequest {
  host: string
  model: string
  prompt: string
  timeoutMs: number
}

export async function ollamaGenerate({ host, model, prompt, timeoutMs }: OllamaRequest): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        // Copy-editing is not a creative task: the same note must always come
        // back the same way, or a retry becomes a reroll.
        options: { temperature: 0 },
        // Reasoning models burn seconds thinking before answering. There is
        // nothing to think about here. Ignored by models that do not support it.
        think: false,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { response?: unknown }
    return typeof body.response === 'string' ? body.response : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const DEFAULT_OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
export const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2'
