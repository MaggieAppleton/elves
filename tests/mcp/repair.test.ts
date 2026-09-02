import { expect, test } from 'vitest'
import { acceptRepair, buildRepairPrompt, lintProse } from '../../src/model/houseStyle'
import { cleanRepair, OllamaRepairer } from '../../mcp/repair'

// --- the prompt ------------------------------------------------------------

test('the repair prompt names every phrase to remove and forbids invention', () => {
  const text = "It's worth noting that this claim plays a crucial role."
  const prompt = buildRepairPrompt(text, lintProse(text))
  expect(prompt).toContain(text)
  expect(prompt).toContain("It's worth noting that")
  expect(prompt).toContain('plays a crucial role')
  expect(prompt).toContain('Do NOT add new ideas')
  expect(prompt).toContain('exactly as written')
})

// --- unwrapping a small model's answer -------------------------------------

test('cleanRepair strips the label a small model prepends', () => {
  expect(cleanRepair('Corrected sentence: This claim needs a source.')).toBe('This claim needs a source.')
  expect(cleanRepair('Rewritten: The middle sags.')).toBe('The middle sags.')
})

test('cleanRepair strips a wrapping quote but keeps a quote inside the note', () => {
  expect(cleanRepair('"This claim needs a source."')).toBe('This claim needs a source.')
  expect(cleanRepair('The phrase "the future of writing" does no work.'))
    .toBe('The phrase "the future of writing" does no work.')
})

test('cleanRepair keeps the first real line and drops trailing commentary', () => {
  expect(cleanRepair('\n\nThe middle sags.\n\nI removed the cliché for you!'))
    .toBe('The middle sags.')
})

// --- the leash -------------------------------------------------------------

const ORIGINAL = "It's worth noting that the 73% figure has no source."

test('a clean deletion is accepted', () => {
  expect(acceptRepair(ORIGINAL, 'The 73% figure has no source.')).toEqual({ ok: true })
})

test('a repair that drops a number is refused', () => {
  // "The figure has no source" is not the same note.
  expect(acceptRepair(ORIGINAL, 'The figure has no source.'))
    .toEqual({ ok: false, reason: 'lost-a-number' })
})

test("a repair that drops the user's quoted words is refused", () => {
  const original = 'I noticed that "the future of writing" is doing no work here.'
  expect(acceptRepair(original, 'That phrase is doing no work here.'))
    .toEqual({ ok: false, reason: 'lost-a-quote' })
})

test('a paraphrase that invents its way to a clean sentence is refused', () => {
  // Observed from llama3.2: "plays a crucial role" came back as "does what is
  // necessary" — clean against every rule, vaguer than what it replaced, and no
  // longer the reviewer's observation.
  expect(acceptRepair('This claim plays a crucial role in the argument.',
    'This claim does what is necessary in the argument.'))
    .toEqual({ ok: false, reason: 'invented-content' })
})

test('a single substitution is still allowed', () => {
  expect(acceptRepair('This section delves into the two systems.',
    'This section covers the two systems.')).toEqual({ ok: true })
})

test('a stranded clause patched with a mid-sentence capital is refused', () => {
  // Observed from llama3.2: deletion strands the tail, the model capitalises
  // the seam, and the result reads as two fragments.
  expect(acceptRepair('The claim is weak, highlighting the need for a source.',
    'The claim is weak; The need for a source.'))
    .toEqual({ ok: false, reason: 'broken-seam' })
})

test('a Title Cased repair is refused', () => {
  // Observed from qwen2.5:7b, which answers a copy-editing request by title
  // casing the result. Every word is the original's and it passes every other
  // check, so it has to be caught on the shape.
  expect(acceptRepair('I noticed that the third card repeats the first.',
    'The Third Card Repeats The First.'))
    .toEqual({ ok: false, reason: 'title-cased' })
})

test('a note that is legitimately capitalised is not mistaken for Title Case', () => {
  expect(acceptRepair('I noticed that Ink and Switch published this in March.',
    'Ink and Switch published this in March.')).toEqual({ ok: true })
})

test('a deletion that leaves the next sentence in lower case is refused', () => {
  // Observed from gemma2:9b, which deletes the phrase opening a sentence and
  // leaves the following word exactly as it found it.
  expect(acceptRepair('Here\'s the thing: the middle sags. The ending lands.',
    'The middle sags. the ending lands.'))
    .toEqual({ ok: false, reason: 'broken-seam' })
})

test('a repair that grows the note is refused', () => {
  expect(acceptRepair('The middle sags.',
    'The middle of the piece sags considerably in several places.').ok).toBe(false)
})

test('a two-word repair is kept — it is exactly the deletion we asked for', () => {
  // A three-word floor threw this away and escalated a repairable note into a
  // rejection, which is the expensive path.
  expect(acceptRepair('I noticed that it repeats.', 'It repeats.')).toEqual({ ok: true })
})

test('a repair that collapses to nothing is refused', () => {
  expect(acceptRepair('No fluff, no filler, no jargon.', '.'))
    .toEqual({ ok: false, reason: 'too-short' })
  expect(acceptRepair('The middle sags.', '   ')).toEqual({ ok: false, reason: 'empty' })
})

test('a repair that still breaks a rule is refused', () => {
  expect(acceptRepair("It's worth noting that this delves into the topic.",
    'This delves into the topic.'))
    .toEqual({ ok: false, reason: 'still-breaks-the-rules' })
})

test('a multi-line answer is refused', () => {
  expect(acceptRepair('The middle sags.', 'The middle sags.\nHope that helps!'))
    .toEqual({ ok: false, reason: 'multi-line' })
})

test('a curly apostrophe is not mistaken for invented content', () => {
  // "that's" and "that’s" must compare equal, or an honest repair reads as a
  // rewrite and gets thrown away.
  expect(acceptRepair('The evidence is thin — and that’s the real problem.',
    "The evidence is thin; that's the real problem.")).toEqual({ ok: true })
})

// --- transport degradation -------------------------------------------------

test('an unreachable Ollama returns null rather than throwing', async () => {
  // Nothing listens on port 1. The gate must fall back to rejecting, which is
  // the behaviour on any machine that has never run Ollama.
  const repairer = new OllamaRepairer('http://127.0.0.1:1', 'llama3.2', 500, 1)
  const text = "It's worth noting that this claim needs a source."
  expect(await repairer.repair(text, lintProse(text))).toBeNull()
  expect(repairer.lastFailure).toBe('unreachable')
})

test('the repairer labels its provenance', () => {
  expect(new OllamaRepairer('http://x', 'llama3.2').label).toBe('ollama/llama3.2')
})

test('an unreachable host stops being called after a couple of tries', async () => {
  // A pass of six notes must not pay the timeout twelve times over on a machine
  // that never runs Ollama.
  let calls = 0
  class Counting extends OllamaRepairer {
    protected override async generate() {
      calls += 1
      return null
    }
  }
  const repairer = new Counting('http://127.0.0.1:1', 'llama3.2', 50, 1)
  const text = "It's worth noting that this claim needs a source."
  const hits = lintProse(text)

  await repairer.repair(text, hits)
  await repairer.repair(text, hits)
  const after = calls
  // The breaker is tripped: further notes short-circuit without touching HTTP.
  for (let i = 0; i < 6; i++) await repairer.repair(text, hits)
  expect(calls).toBe(after)
  expect(repairer.lastFailure).toBe('unreachable')
})

test('the breaker reopens once the cooldown has passed', async () => {
  let calls = 0
  let clock = 1_000_000
  class Fake extends OllamaRepairer {
    protected override now() { return clock }
    protected override async generate() {
      calls += 1
      return null
    }
  }
  const repairer = new Fake('http://127.0.0.1:1', 'llama3.2', 50, 1)
  const text = "It's worth noting that this claim needs a source."
  const hits = lintProse(text)

  await repairer.repair(text, hits)
  await repairer.repair(text, hits)
  const tripped = calls
  await repairer.repair(text, hits)
  expect(calls).toBe(tripped) // still paused

  clock += 61_000
  await repairer.repair(text, hits)
  expect(calls).toBe(tripped + 1) // probed again
})

test('a host that answers but fails the leash keeps being tried', async () => {
  // Ollama working and the repair not holding is not a transport problem --
  // the next note may repair fine, so this must not trip the breaker.
  let calls = 0
  class Useless extends OllamaRepairer {
    protected override async generate() {
      calls += 1
      return 'Something entirely different was invented here instead.'
    }
  }
  const repairer = new Useless('http://x', 'llama3.2', 50, 1)
  const text = "It's worth noting that this claim needs a source."
  const hits = lintProse(text)

  for (let i = 0; i < 4; i++) await repairer.repair(text, hits)
  expect(calls).toBe(4)
  expect(repairer.lastFailure).not.toBe('unreachable')
})
