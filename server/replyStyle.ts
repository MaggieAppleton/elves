import {
  acceptReplyRepair,
  buildReplyRepairPrompt,
  lintProse,
} from '../src/model/houseStyle'
import { DEFAULT_OLLAMA_HOST, REPAIR_MODEL, ollamaGenerate } from './ollamaClient'

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

/** Long enough for several paragraphs on a slower machine, short enough that a
 * user waiting on a reply does not notice. Past this, saving the original is
 * the better answer. */
const REPLY_TIMEOUT_MS = 12_000

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
  const raw = await ollamaGenerate({
    host: options.host ?? DEFAULT_OLLAMA_HOST,
    model: options.model ?? REPAIR_MODEL,
    prompt: buildReplyRepairPrompt(text, hits),
    timeoutMs: options.timeoutMs ?? REPLY_TIMEOUT_MS,
  })
  if (raw === null) return { text, repaired: false, broke }

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
  const wrapped = /^"([\s\S]*)"$/.exec(s) ?? /^“([\s\S]*)”$/.exec(s)
  if (wrapped) s = wrapped[1]
  return s.trim()
}
