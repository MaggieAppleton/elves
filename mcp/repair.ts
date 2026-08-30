import {
  acceptRepair,
  buildRepairPrompt,
  type RepairRejection,
  type StyleHit,
} from '../src/model/houseStyle'

/**
 * Local repair of a note that breaks house style.
 *
 * The gate used to have one move: reject, and make the agent write it again.
 * That is the expensive move — a rejection adds a turn to an agent loop whose
 * input is the whole conversation so far, so it costs far more than the note it
 * fixes and it costs more the later in a pass it happens. The work itself is
 * tiny: strike out "It's worth noting that", capitalise what follows. A 2GB
 * model on this machine does that for nothing.
 *
 * So repair comes first and rejection is the fallback. Ollama is already how
 * Elves writes card gists (server/summarize/ollama.ts), and this follows that
 * module's contract exactly: any failure returns null, and the caller carries
 * on as if the repairer did not exist. Ollama not running, model not pulled,
 * request timed out, reply unusable — every one of those lands on the old
 * behaviour, which still works. The feature is additive, never load-bearing.
 */
export interface Repairer {
  /** The repaired note, or null if it could not be repaired safely. */
  repair(text: string, hits: StyleHit[]): Promise<RepairResult | null>
  /** Provenance for logs, e.g. 'ollama/llama3.2'. */
  readonly label: string
}

export interface RepairResult {
  text: string
  /** Attempts spent, for logging. */
  attempts: number
}

/** Why the last attempt was discarded — surfaced in stderr so a misbehaving
 * local model is visible rather than silently doubling the rejection rate. */
export type RepairFailure = RepairRejection | 'unreachable'

/** Consecutive transport failures before the repairer stops trying for a while. */
const BREAKER_TRIP = 2
/** How long it stays tripped. Long enough that a pass of six notes doesn't pay
 * the timeout six times over; short enough that starting Ollama mid-session
 * gets picked up without a restart. */
const BREAKER_COOLDOWN_MS = 60_000

export class OllamaRepairer implements Repairer {
  readonly label: string
  /** Set by repair() so the caller can log why a repair was thrown away. */
  lastFailure: RepairFailure | null = null

  /**
   * Circuit breaker for a host that isn't there.
   *
   * Ollama unloads an idle model after a few minutes, so a cold call can run
   * past the timeout — and on a machine that never runs Ollama at all, every
   * attempt does. Without this, a review pass of six notes pays the full
   * timeout twice per note before falling back, turning a cheap feature into a
   * minute and a half of dead waiting.
   *
   * Only TRANSPORT failures trip it. A repair that comes back and fails the
   * leash means Ollama is alive and working; the next note may well repair
   * fine, so that must not stop us trying.
   */
  private consecutiveTransportFailures = 0
  private breakerUntil = 0

  constructor(
    private readonly host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    private readonly model = process.env.OLLAMA_MODEL ?? 'llama3.2',
    // Shorter than the summarizer's 20s: a gist is written in the background,
    // but a repair sits in the write path with the agent waiting on the tool
    // result. Past a few seconds, rejecting is the faster answer.
    private readonly timeoutMs = 8_000,
    // Two tries, not one: the first failure is usually the model adding a
    // preamble, which a retry at temperature 0 rarely repeats. Not more than
    // two — each costs a second of the agent's wall clock.
    private readonly maxAttempts = 2,
  ) {
    this.label = `ollama/${this.model}`
  }

  async repair(text: string, hits: StyleHit[]): Promise<RepairResult | null> {
    this.lastFailure = null
    if (this.now() < this.breakerUntil) {
      this.lastFailure = 'unreachable'
      return null
    }

    const prompt = buildRepairPrompt(text, hits)
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const raw = await this.generate(prompt)
      if (raw === null) {
        this.lastFailure = 'unreachable'
        this.consecutiveTransportFailures += 1
        if (this.consecutiveTransportFailures >= BREAKER_TRIP) {
          this.breakerUntil = this.now() + BREAKER_COOLDOWN_MS
          console.error(
            `[elves] house style: ${this.label} unreachable — pausing local repair for ${BREAKER_COOLDOWN_MS / 1000}s`,
          )
        }
        return null
      }
      // It answered, so the host is fine whatever the leash decides next.
      this.consecutiveTransportFailures = 0
      const candidate = cleanRepair(raw)
      const verdict = acceptRepair(text, candidate)
      if (verdict.ok) return { text: candidate, attempts: attempt }
      this.lastFailure = verdict.reason
    }
    return null
  }

  /** Overridable so a test can move time without waiting a minute. */
  protected now(): number {
    return Date.now()
  }

  /** The one network call. Protected so a test can stand in for the host. */
  protected async generate(prompt: string): Promise<string | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { temperature: 0 },
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
}

/**
 * Tidy a raw completion into one candidate sentence.
 *
 * Small models like to answer the question rather than do the job: a label
 * ("Corrected sentence:"), a wrapper quote, a cheerful note afterwards. Strip
 * the packaging and keep the first real line — if what is left is still wrong,
 * acceptRepair throws it away, so this only has to be generous, not clever.
 */
export function cleanRepair(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(?:corrected\s+sentence|corrected|rewritten|output|answer|result)\s*:\s*/i, '')
  s = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  // A wrapping pair of quotes is packaging; a quote the agent put around the
  // user's words is content, so only strip when the whole line is wrapped.
  const wrapped = /^"([^"]*)"$/.exec(s) ?? /^“([^”]*)”$/.exec(s)
  if (wrapped) s = wrapped[1]
  return s.trim()
}
