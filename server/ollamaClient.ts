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

/**
 * Stop calling a host that isn't answering.
 *
 * Ollama unloads an idle model after a few minutes, so a cold call can outrun
 * any sane timeout — and on a machine that never runs Ollama, every call does.
 * Both repair paths pay that cost repeatedly without this: a review pass of six
 * notes, or a thread where several replies in a row trip a rule.
 *
 * Only TRANSPORT failures count. A reply that comes back and fails its leash
 * means the host is alive and working, and the next one may well succeed.
 */
export class TransportBreaker {
  private failures = 0
  private until = 0

  constructor(
    private readonly trip = 2,
    private readonly cooldownMs = 60_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get open(): boolean {
    return this.clock() < this.until
  }

  recordSuccess(): void {
    this.failures = 0
  }

  /** @returns true when this failure is the one that tripped the breaker. */
  recordFailure(): boolean {
    this.failures += 1
    if (this.failures < this.trip) return false
    this.until = this.clock() + this.cooldownMs
    return true
  }
}

export const DEFAULT_OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
export const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2'

/**
 * The model that repairs house style, which is NOT necessarily the one that
 * writes card gists — hence its own variable rather than sharing OLLAMA_MODEL.
 *
 * Summarising rewards a model that reads well and paraphrases freely. Repair
 * rewards the opposite: the note is already right, and the job is to strike a
 * phrase out of it and leave everything else alone. Measured on this M1 Pro
 * against twenty real notes (bench/repairModels.ts):
 *
 *   llama3.2 (2GB)     12/20 repaired, 0 bad, 0.8s   <- default
 *   qwen2.5:7b (4.7GB) 14/20 repaired, 2 bad, 1.3s
 *   gemma2:9b (5.4GB)  15/20 repaired, ~4 bad, 5.1s
 *   gemma2:27b (15GB)  unusable: 100s to load, 221s per repair
 *
 * The bigger models repair more notes and break more of them — "The card
 * stands argument", "The Third Card Repeats The First", a sentence resuming in
 * lower case. A repair that lands wrong is worse than one that never happened,
 * since the note carries the agent's authorship mark either way, so the
 * smallest model wins on the metric that matters. Override if that changes.
 */
export const REPAIR_MODEL = process.env.ELVES_REPAIR_MODEL ?? DEFAULT_OLLAMA_MODEL
