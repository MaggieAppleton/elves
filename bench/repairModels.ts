/**
 * Which local model should repair house style?
 *
 *   npx tsx bench/repairModels.ts llama3.2
 *
 * Not a test — it needs Ollama running and takes minutes. It exists because
 * the answer is counterintuitive and will go stale: a bigger model repairs
 * MORE notes and breaks more of them, and the metric that matters is not how
 * many it fixes but how many it gets wrong, since a bad repair lands on the
 * user's canvas under the agent's authorship mark.
 *
 * Measured on an M1 Pro / 26GB, 2026-08-30:
 *
 *   llama3.2 (2GB)      12/20 repaired,  0 bad,   0.8s/note   <- the default
 *   qwen2.5:7b (4.7GB)  14/20 repaired,  2 bad,   1.3s/note
 *   gemma2:9b (5.4GB)   15/20 repaired, ~4 bad,   5.1s/note
 *   gemma2:27b (15GB)   unusable: 100s to load, 221s per repair
 *
 * "Bad" is by eye, and that is the point — the leash is a phrase checker, not
 * a grammar checker, so the only way to count damage is to read the output.
 * The failures the bigger models produced ("The card stands argument", "The
 * Third Card Repeats The First", a sentence resuming in lower case) are why
 * the title-cased and broken-seam checks exist.
 *
 * Re-run this before changing ELVES_REPAIR_MODEL, and read every line of the
 * output rather than the summary counts.
 */
import { lintProse } from '../src/model/houseStyle'
import { OllamaRepairer } from '../mcp/repair'
import { repairReply } from '../server/replyStyle'

// The 20 notes from the original calibration, so models are compared on the
// same ground. Each one breaks at least one rule.
const NOTES = [
  "It's worth noting that this claim needs a source.",
  'I noticed that the third card repeats the first.',
  'You might consider adding a source here.',
  'Great question! The evidence here is thin.',
  'This section is perhaps somewhat unclear.',
  'Ultimately, the piece holds together.',
  "Here's the thing: the middle sags.",
  'Turns out the opening was the ending.',
  "Let's be honest, this paragraph is doing nothing.",
  'Experts argue that spatial drafting improves recall.',
  'The claim is weak, highlighting the need for a source.',
  'Despite these challenges, the piece works.',
  'This claim plays a crucial role in the argument.',
  'This section delves into the intricate interplay of the two systems.',
  "It's not a structure problem — it's a clarity problem.",
  'The card stands as a testament to the argument.',
  'The evidence is thin — and that’s the real problem.',
  'No fluff, no filler, no jargon.',
  "It's worth noting that the 73% figure has no source.",
  'I noticed that "the future of writing" is doing no work here.',
]

const REPLIES = [
  "It's worth noting that the opening delves into three separate claims, but only the first has a source. Here's the thing: the middle section repeats the argument you already made in card 4. Ultimately, the structure holds, but the evidence does not.",
  'Great question! I looked at all 12 cards. It seems like the argument is not just about tooling but about attention. Experts argue this distinction matters, and that\'s the real problem with the current opening.',
]

const model = process.argv[2] ?? 'llama3.2'
console.log(`\n=== ${model} ===`)

const repairer = new OllamaRepairer(undefined, model, 30_000, 2)
let ok = 0
const started = Date.now()
const lines: string[] = []

for (const text of NOTES) {
  const t0 = Date.now()
  const res = await repairer.repair(text, lintProse(text))
  const ms = Date.now() - t0
  if (res) {
    ok += 1
    lines.push(`  OK   ${String(ms).padStart(5)}ms  ${text}\n            -> ${res.text}`)
  } else {
    lines.push(`  --   ${String(ms).padStart(5)}ms  (${repairer.lastFailure}) ${text}`)
  }
}
const noteMs = Date.now() - started
console.log(lines.join('\n'))
console.log(`\n  notes repaired: ${ok}/${NOTES.length}   mean ${(noteMs / NOTES.length / 1000).toFixed(1)}s`)

let replyOk = 0
const rStart = Date.now()
for (const text of REPLIES) {
  const res = await repairReply(text, { model, timeoutMs: 60_000 })
  if (res.repaired) {
    replyOk += 1
    console.log(`\n  REPLY repaired:\n    before: ${text}\n    after:  ${res.text}`)
  } else {
    console.log(`\n  REPLY unchanged (${res.broke.join(', ')}): ${text.slice(0, 70)}...`)
  }
}
console.log(`\n  replies repaired: ${replyOk}/${REPLIES.length}   mean ${((Date.now() - rStart) / REPLIES.length / 1000).toFixed(1)}s`)
