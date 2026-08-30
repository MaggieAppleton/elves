import { expect, test } from 'vitest'
import { acceptReplyRepair, buildReplyRepairPrompt, lintProse } from '../../src/model/houseStyle'
import { cleanReply, repairReply } from '../../server/replyStyle'

// A reply is several sentences of prose written TO the user, not a one-line
// margin note, so it gets its own prompt and its own leash -- and unlike the
// canvas gate, this path never blocks: a repair that misses the bar is dropped
// and the agent's own words are saved.

const SLOPPY = "It's worth noting that the opening delves into three separate claims. Here's the thing: only the first has a source."

test('the reply prompt insists the message is edited, not summarised', () => {
  const prompt = buildReplyRepairPrompt(SLOPPY, lintProse(SLOPPY))
  expect(prompt).toContain(SLOPPY)
  expect(prompt).toContain('This is not a summary')
  expect(prompt).toContain('Do not condense')
  expect(prompt).toContain('message written TO the reader')
})

test('the reply prompt lists each offending phrase once', () => {
  const text = "It's worth noting that this delves in. It's worth noting that it delves out."
  const prompt = buildReplyRepairPrompt(text, lintProse(text))
  expect(prompt.match(/"It's worth noting that"/g) ?? []).toHaveLength(1)
})

// --- the leash -------------------------------------------------------------

test('an edit that removes a cliché and keeps the substance is accepted', () => {
  expect(acceptReplyRepair(
    SLOPPY,
    'The opening covers three separate claims. Only the first has a source.',
  )).toEqual({ ok: true })
})

test('a repair need only reduce the offences, not eliminate them', () => {
  // Several sentences can carry several offences and a small model rarely gets
  // them all. Better is the bar; perfect is not.
  const before = lintProse(SLOPPY).length
  const partial = "The opening delves into three separate claims. Only the first has a source."
  expect(lintProse(partial).length).toBeLessThan(before)
  expect(lintProse(partial).length).toBeGreaterThan(0)
  expect(acceptReplyRepair(SLOPPY, partial)).toEqual({ ok: true })
})

test('a repair that fixes nothing is refused', () => {
  expect(acceptReplyRepair(SLOPPY, SLOPPY)).toEqual({ ok: false, reason: 'still-breaks-the-rules' })
})

test('a summary dressed up as an edit is refused', () => {
  // The failure that actually shows up: the model condenses several paragraphs
  // into one and quietly loses what the user asked about.
  expect(acceptReplyRepair(SLOPPY, 'Only the first claim has a source.'))
    .toEqual({ ok: false, reason: 'too-short' })
})

test('a reply that grows is refused', () => {
  const padded = SLOPPY.replace('.', '.') + ' I hope this explanation of the situation is helpful to you today.'
  expect(acceptReplyRepair(SLOPPY, padded).ok).toBe(false)
})

test('numbers and quoted spans must survive a reply repair too', () => {
  const withNumber = "It's worth noting that 3 of the 7 claims have no source."
  expect(acceptReplyRepair(withNumber, 'Some claims have no source. The rest are fine here.'))
    .toEqual({ ok: false, reason: 'lost-a-number' })

  const withQuote = 'It\'s worth noting that "the future of writing" does no work in the opening paragraph.'
  expect(acceptReplyRepair(withQuote, 'That phrase does no work in the opening paragraph of this piece.'))
    .toEqual({ ok: false, reason: 'lost-a-quote' })
})

test('a reply left with a lower-case sentence start is refused', () => {
  // gemma2:9b's signature failure on multi-sentence text: it deletes the phrase
  // opening a sentence and leaves the next word untouched. It broke both of the
  // benchmark replies this way, and every other check passed them.
  expect(acceptReplyRepair(SLOPPY,
    'The opening covers three separate claims. only the first has a source.'))
    .toEqual({ ok: false, reason: 'broken-seam' })
})

test('an empty reply is refused', () => {
  expect(acceptReplyRepair(SLOPPY, '   ')).toEqual({ ok: false, reason: 'empty' })
})

// --- unwrapping ------------------------------------------------------------

test('cleanReply strips a label and a wrapping quote but keeps the paragraphs', () => {
  expect(cleanReply('Edited message: The middle sags.\n\nThe ending lands.'))
    .toBe('The middle sags.\n\nThe ending lands.')
  expect(cleanReply('"The middle sags.\n\nThe ending lands."'))
    .toBe('The middle sags.\n\nThe ending lands.')
})

test('cleanReply leaves a reply that merely begins and ends with a quotation', () => {
  // A greedy strip turned `"one" and "two"` into `one" and "two`, which the
  // leash then discarded — so the repair was silently lost rather than applied.
  expect(cleanReply('"one" and "two"')).toBe('"one" and "two"')
})

test('cleanReply never truncates a multi-paragraph reply to its first line', () => {
  // The note version keeps only the first line; doing that here would silently
  // drop most of an answer the user is waiting on.
  const many = 'First point.\n\nSecond point.\n\nThird point.'
  expect(cleanReply(many)).toBe(many)
})

// --- fail-open -------------------------------------------------------------

test('a clean reply is returned untouched and never reaches the model', async () => {
  // Pointed at a dead port: if it called out, it would stall and still return
  // the original. Instant return proves the regex short-circuit works.
  const clean = 'The opening covers three claims. Only the first has a source.'
  const result = await repairReply(clean, { host: 'http://127.0.0.1:1', timeoutMs: 50 })
  expect(result).toEqual({ text: clean, repaired: false, broke: [] })
})

test('every reply survives an unreachable local model, however many in a row', async () => {
  // The breaker itself is tested deterministically in TransportBreaker's own
  // cases; what matters here is that tripping it changes nothing the caller
  // sees. Six replies, no Ollama, six sets of the agent's own words.
  const dead = { host: 'http://127.0.0.1:1', timeoutMs: 200 }
  for (let i = 0; i < 6; i++) {
    const result = await repairReply(SLOPPY, dead)
    expect(result.text).toBe(SLOPPY)
    expect(result.repaired).toBe(false)
    expect(result.broke).toContain('didactic-hedge')
  }
})

test('an unreachable local model leaves the agent\'s own words saved', async () => {
  // The whole posture of this path: there is nobody to ask for a rewrite, so a
  // missing Ollama must be indistinguishable from the behaviour before it
  // existed.
  const result = await repairReply(SLOPPY, { host: 'http://127.0.0.1:1', timeoutMs: 50 })
  expect(result.text).toBe(SLOPPY)
  expect(result.repaired).toBe(false)
  // It still reports what the reply broke, so the log line is useful even when
  // the repair could not run.
  expect(result.broke).toContain('didactic-hedge')
})
