import {
  acceptReplyRepair,
  buildReplyRepairPrompt,
  lintProse,
} from '../src/model/houseStyle'
import { DEFAULT_OLLAMA_HOST, REPAIR_MODEL, TransportBreaker, ollamaGenerate } from './ollamaClient'

/**
 * House style for the one surface nothing else can reach.
 *
 * Every string an agent writes ONTO the canvas passes the MCP style gate, which
 * repairs it or hands it back. An agent's CHAT REPLY passes through no tool at
 * all: an annotation-reply run is denied every elves tool outright, and its
 * answer is saved into the thread and shown beside the user's draft exactly as
 * the model typed it. Until now the system prompt was the only thing standing
 * between "It's worth noting that..." and the user's margin.
 *
 * So the reply gets the same treatment, with one deliberate difference:
 * this path FAILS OPEN. The gate can reject a tool call because there is an
 * agent on the other end who will write it again; there is nobody to ask here,
 * and a reply is a conversation turn the user is waiting on. If the local model
 * is missing, slow, or produces something that misses the bar, the agent's own
 * words are saved — exactly what happened before this existed. The worst case
 * is the status quo.
 */

/**
 * This repair sits between the agent's last word and the saved message, and the
 * annotation stream stays open across it — the thread shows "running" for the
 * whole wait after the agent has already finished. Six seconds is ample for a
 * repair that measures around a second on this machine, and cheap to lose: a
 * timeout saves the agent's own words, which is the status quo.
 */
const REPLY_TIMEOUT_MS = 6_000

/**
 * Shared across replies for the lifetime of the server process. Without it, a
 * thread on a machine with no Ollama pays the full timeout on every reply that
 * trips a rule, each one stalling the stream after the answer is already known.
 */
const breaker = new TransportBreaker()

export interface ReplyRepair {
  text: string
  /** True when the local model actually changed something. */
  repaired: boolean
  /** Rules the original broke, for the log line. */
  broke: string[]
}

/**
 * Tidy a reply if it needs it and the local model can do it safely.
 *
 * Always resolves, always returns usable text. A reply with nothing wrong costs
 * nothing at all: the check is a regex pass and the model is never called.
 */
export async function repairReply(
  text: string,
  options: { host?: string; model?: string; timeoutMs?: number } = {},
): Promise<ReplyRepair> {
  const hits = lintProse(text)
  if (!hits.length) return { text, repaired: false, broke: [] }

  const broke = [...new Set(hits.map((h) => h.ruleId))]
  if (breaker.open) return { text, repaired: false, broke }

  const raw = await ollamaGenerate({
    host: options.host ?? DEFAULT_OLLAMA_HOST,
    model: options.model ?? REPAIR_MODEL,
    prompt: buildReplyRepairPrompt(text, hits),
    timeoutMs: options.timeoutMs ?? REPLY_TIMEOUT_MS,
  })
  if (raw === null) {
    if (breaker.recordFailure()) {
      console.error('[elves] house style: local model unreachable — pausing reply repair for 60s')
    }
    return { text, repaired: false, broke }
  }
  breaker.recordSuccess()

  const candidate = cleanReply(raw)
  const verdict = acceptReplyRepair(text, candidate)
  if (!verdict.ok) return { text, repaired: false, broke }
  return { text: candidate, repaired: true, broke }
}

/**
 * Strip the packaging a small model puts around a multi-paragraph answer.
 *
 * Unlike a one-line note, the body here is allowed to contain newlines, so this
 * only removes a leading label and a wrapping quote pair — never collapses to
 * the first line, which would silently truncate the reply.
 */
export function cleanReply(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(?:edited\s+message|edited|corrected|rewritten|output|answer|result)\s*:\s*/i, '')
  s = s.trim()
  // No interior quote mark: a reply that merely begins and ends with a
  // quotation ("one" and "two") is not a wrapped string, and stripping its
  // outer marks corrupts it. The character class already spans newlines, so a
  // genuinely wrapped multi-paragraph reply still unwraps.
  const wrapped = /^"([^"]*)"$/.exec(s) ?? /^“([^”]*)”$/.exec(s)
  if (wrapped) s = wrapped[1]
  return s.trim()
}
