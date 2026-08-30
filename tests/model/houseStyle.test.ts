import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  HOUSE_STYLE,
  RULES,
  RULE_IDS,
  formatStyleRejection,
  lintProse,
  maskQuotes,
} from '../../src/model/houseStyle'
import { PERSONALITIES, PERSONALITY_IDS, composeBrief } from '../../src/model/reviews'

// --- the catalogue ---------------------------------------------------------

test('every rule has a unique id and a why line that says what to do instead', () => {
  expect(new Set(RULE_IDS).size).toBe(RULES.length)
  for (const rule of RULES) {
    expect(rule.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(rule.why.length).toBeGreaterThan(20)
    expect(rule.scope === 'any' || rule.scope === 'multi').toBe(true)
  }
})

test('the three patterns known to misfire on short technical notes are not ported', () => {
  // llm-cliché-highlighter's colon-triple ("Noisy in technical writing — leave
  // it off by default if your corpus is documentation"), x-is-dead, and
  // stranded-auxiliary. A check that cries wolf gets worked around.
  expect(RULE_IDS).not.toContain('colon-triple')
  expect(RULE_IDS).not.toContain('x-is-dead')
  expect(RULE_IDS).not.toContain('stranded-auxiliary')
})

// --- detection -------------------------------------------------------------

const CAUGHT: [string, string][] = [
  ['preamble', 'I noticed that the third card repeats the first.'],
  ['preamble', 'You might consider adding a source here.'],
  ['flattery', 'Great question! The evidence here is thin.'],
  ['flattery', "You're absolutely right about the ordering."],
  ['hedge-stack', 'This section is perhaps somewhat unclear.'],
  ['tidy-closer', 'Ultimately, the piece holds together.'],
  ['tidy-closer', 'In short, the middle sags.'],
  ['em-dash-reveal', 'The evidence is thin — and that’s the real problem.'],
  ['staged-reveal', "Here's the thing: the middle sags."],
  ['turns-out', 'Turns out the opening was the ending.'],
  ['performative-honesty', "Let's be honest, this paragraph is doing nothing."],
  ['no-chain', 'No fluff, no filler, no jargon.'],
  ['not-nothing', "That's not nothing."],
  ['therapist-voice', 'Sit with that for a moment.'],
  ['fits-in-your-head', 'It just works, which is the selling point.'],
  ['ai-vocab', 'This section delves into the intricate interplay of the two systems.'],
  ['negative-parallelism', "It's not a structure problem — it's a clarity problem."],
  ['negative-parallelism', 'This is not just a wording issue but a structural one.'],
  ['didactic-hedge', "It's worth noting that this claim needs a source."],
  ['testament', 'The card stands as a testament to the argument.'],
  ['inflated-role', 'This claim plays a crucial role in the argument.'],
  ['scene-setting', 'In the ever-evolving landscape of writing tools, this matters.'],
  ['vague-authority', 'Experts argue that spatial drafting improves recall.'],
  ['vague-authority', 'Studies show that readers skim.'],
  ['challenges-outlook', 'Despite these challenges, the piece works.'],
  ['participle-tail', 'The claim is weak, highlighting the need for a source.'],
  ['promotional', 'The essay is a hidden gem.'],
  ['chatbot-leftovers', 'As an AI language model, I would flag this.'],
]

for (const [ruleId, text] of CAUGHT) {
  test(`${ruleId} catches: ${text}`, () => {
    expect(lintProse(text).map((h) => h.ruleId)).toContain(ruleId)
  })
}

// The notes the app's own docs hold up as examples of a good margin note. If
// the gate rejects these, it rejects the thing it exists to protect.
const GOOD_NOTES = [
  'This claim needs a concrete observation. Could we name the three people who hesitated?',
  "The second half says the useful thing. Try cutting everything after 'future'.",
  'What did it cost her?',
  'You claim X in three cards but never argue it — which card is the argument?',
  'you spend two paragraphs on this spatial layout — this is a diagram',
  'who loses if this is true?',
  'I lost the thread here.',
  'The 73% figure has no source.',
  'Prior art: end-user programming',
  'The argument holds. The evidence for the middle section is thin, but nothing here breaks.',
  'This holds up.',
  'The opening promises a history and delivers a manifesto.',
  'Where does the reader learn that the system is local-first?',
  'this card reads like it wants to open the section',
]

for (const note of GOOD_NOTES) {
  test(`passes a real margin note: ${note.slice(0, 48)}`, () => {
    expect(lintProse(note)).toEqual([])
  })
}

test('one hit per rule, however many times the rule is broken', () => {
  const hits = lintProse('We delve into the intricate tapestry of the seamless interplay.')
  expect(hits.filter((h) => h.ruleId === 'ai-vocab')).toHaveLength(1)
})

test('hits are ordered by where the offence appears', () => {
  const hits = lintProse("It's worth noting that this claim plays a crucial role in the argument.")
  expect(hits.map((h) => h.ruleId)).toEqual(['didactic-hedge', 'inflated-role'])
  expect(hits[0].start).toBeLessThan(hits[1].start)
})

test('a hit carries the offending span verbatim, sliced from the original text', () => {
  const text = 'This claim plays a crucial role in the argument.'
  const [hit] = lintProse(text)
  expect(text.slice(hit.start, hit.end)).toBe(hit.text)
  expect(hit.text).toBe('plays a crucial role')
})

test('empty and whitespace-only text is not an offence', () => {
  expect(lintProse('')).toEqual([])
  expect(lintProse('   \n  ')).toEqual([])
})

// --- scope -----------------------------------------------------------------

test('multi-sentence rules stay off a one-sentence note', () => {
  // A single question is the entire point of a question card.
  expect(lintProse('Who is this for?')).toEqual([])
})

test('multi-sentence rules fire once the text really has several sentences', () => {
  const hits = lintProse('Who is this for? What do they already know? Why now?')
  expect(hits.map((h) => h.ruleId)).toContain('stacked-questions')
})

test('repeated sentence openers are caught, but only past three', () => {
  const two = 'Maybe nobody needed it. Maybe it was fine.'
  const three = 'Maybe nobody needed it. Maybe it was fine. Maybe that is the answer.'
  expect(lintProse(two).map((h) => h.ruleId)).not.toContain('repeated-openers')
  expect(lintProse(three).map((h) => h.ruleId)).toContain('repeated-openers')
})

test('multi can be forced on or off regardless of the text', () => {
  const text = 'Who is this for? What do they know?'
  expect(lintProse(text, { multi: false }).map((h) => h.ruleId)).not.toContain('stacked-questions')
  expect(lintProse('Who? Why?', { multi: true }).map((h) => h.ruleId)).toContain('stacked-questions')
})

// --- quoting the user ------------------------------------------------------

test('maskQuotes blanks quoted runs and preserves every offset', () => {
  const text = 'The line "it is worth noting" should go.'
  const masked = maskQuotes(text)
  expect(masked).toHaveLength(text.length)
  expect(masked).not.toContain('worth noting')
  expect(masked.startsWith('The line ')).toBe(true)
  expect(masked.endsWith(' should go.')).toBe(true)
})

test('quoting the user\'s own prose is exempt', () => {
  // The Trimmer is told it may quote a shorter phrasing; those are the user's
  // words, and the check has no business grading them.
  expect(lintProse('Cut "it\'s worth noting that" from the opening.')).toEqual([])
  expect(lintProse('The phrase “plays a crucial role” is doing no work here.')).toEqual([])
})

test('the exemption does not leak past the closing quote', () => {
  const hits = lintProse('Cut "the opening" — it\'s worth noting nothing.')
  expect(hits.map((h) => h.ruleId)).toContain('didactic-hedge')
})

test('an apostrophe does not open a quoted run', () => {
  // The dangerous case for single quotes: an apostrophe is the same character
  // as a closing quote, so "It's ... doesn't" must not read as a quoted span
  // and mask the didactic hedge sitting between them.
  expect(lintProse("It's worth noting that the card doesn't say this.").map((h) => h.ruleId))
    .toContain('didactic-hedge')
  expect(lintProse("Don't delve into it; the reader won't follow.").map((h) => h.ruleId))
    .toContain('ai-vocab')
})

test('a cliché is exempt inside every delimiter a reviewer would reach for', () => {
  // Critiquing a cliché means writing it down. Whichever way the agent marks
  // the quotation, the note it most needs to leave must be writable.
  for (const note of [
    'The phrase "the ever-evolving landscape" is doing no work here.',
    'The phrase “the ever-evolving landscape” is doing no work here.',
    'The phrase `the ever-evolving landscape` is doing no work here.',
    "The phrase 'the ever-evolving landscape' is doing no work here.",
    'The phrase ‘the ever-evolving landscape’ is doing no work here.',
  ]) {
    expect(lintProse(note)).toEqual([])
  }
})

test('a quoted delimiter still lets a cliché OUTSIDE it be caught', () => {
  // The exemption is a span, not a switch: quoting one phrase must not smuggle
  // a second one through in the surrounding sentence.
  const hits = lintProse('The phrase `delve` is fine, but this claim plays a crucial role.')
  expect(hits.map((h) => h.ruleId)).toEqual(['inflated-role'])
})

test("a mention with no delimiter at all is still caught, on purpose", () => {
  // When you mention a phrase you quote it. Leaving this uncaught would need a
  // use/mention judgement no regex can make, and any "the phrase X" escape
  // would become the way around the whole check.
  expect(lintProse('Card 4 leans on ever-evolving landscape framing.').length).toBeGreaterThan(0)
})

// --- the rejection message -------------------------------------------------

test('the rejection names every rule, quotes each span, and says what to do', () => {
  const text = "It's worth noting that this claim plays a crucial role."
  const msg = formatStyleRejection('comment', text, lintProse(text))
  expect(msg).toContain('Rejected: this comment hits 2 house-style rules.')
  expect(msg).toContain('didactic-hedge')
  expect(msg).toContain('inflated-role')
  expect(msg).toContain('plays a crucial role')
  expect(msg).toContain('call the tool again')
  // A caret diagram, aligned under the offences.
  expect(msg).toContain('^')
  const caretLine = msg.split('\n').find((l) => l.trim().startsWith('^'))!
  expect(caretLine.indexOf('^')).toBe(2 + text.indexOf("It's worth noting"))
})

test('one hit reads as "rule", not "rules"', () => {
  const text = 'This claim plays a crucial role.'
  expect(formatStyleRejection('comment', text, lintProse(text))).toContain('1 house-style rule.')
})

test('the caret diagram is dropped for text it cannot align under', () => {
  const long = `We delve into it. ${'padding words here '.repeat(20)}`
  const msg = formatStyleRejection('verdict', long, lintProse(long))
  expect(msg).toContain('ai-vocab')
  expect(msg.split('\n').some((l) => l.trim().startsWith('^'))).toBe(false)
})

test('the field name is used verbatim, so each tool names its own thing', () => {
  const text = 'Turns out this matters.'
  expect(formatStyleRejection('figure description', text, lintProse(text)))
    .toContain('this figure description hits')
})

// --- one source of truth ---------------------------------------------------

test('HOUSE_STYLE names each rule an agent is most likely to reach for', () => {
  for (const phrase of [
    'delve',
    "it's worth noting",
    'Great question',
    'plays a crucial role',
    'not just X but Y',
    "Here's the thing",
    'No fluff, no filler',
    'experts argue',
    'as an AI language model',
    'backticks',
  ]) {
    expect(HOUSE_STYLE.toLowerCase()).toContain(phrase.toLowerCase())
  }
})

test('the house style HOUSE_STYLE describes passes its own check', () => {
  // The rules cannot be written in the register they ban.
  const prose = HOUSE_STYLE.split('\n')
    .filter((l) => !l.trim().startsWith('-') && !l.includes('Model vocabulary'))
    .join('\n')
  const hits = prose.split('\n').flatMap((line) => lintProse(line))
  expect(hits.map((h) => `${h.ruleId}: ${h.text}`)).toEqual([])
})

test('the skill file carries HOUSE_STYLE verbatim, so the two cannot drift', () => {
  const skill = readFileSync(new URL('../../skill/elves-house-style.md', import.meta.url), 'utf8')
  for (const line of HOUSE_STYLE.split('\n')) {
    if (!line.trim()) continue
    expect(skill).toContain(line)
  }
})

test('every review brief carries the style rules and the fact that they are enforced', () => {
  for (const id of PERSONALITY_IDS) {
    const brief = composeBrief(PERSONALITIES[id], null)
    expect(brief).toContain('House style applies to every word')
    expect(brief).toContain('a small local model strips what it can')
    expect(brief).toContain('backticks')
  }
})

test('the personality briefs themselves are clean prose', () => {
  // The briefs are what an agent reads immediately before writing. If they are
  // slop, they teach slop.
  for (const id of PERSONALITY_IDS) {
    const hits = PERSONALITIES[id].brief
      .split('\n')
      .flatMap((line) => lintProse(line))
      // "no context and no second chances" is deliberate rhythm in prose the
      // user never sees; the gate only guards what lands on the canvas.
      .filter((h) => h.ruleId !== 'no-chain')
    expect(hits.map((h) => `${id} ${h.ruleId}: ${h.text}`)).toEqual([])
  }
})
