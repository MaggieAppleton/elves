/**
 * House style — the one rule set governing every string an agent writes into Elves.
 *
 * Everything an agent leaves on the canvas is read in the margin of someone's
 * draft: a comment, a question, a floating note, a figure title, a section
 * label, a review verdict. Margin notes are read fast and trusted or not on
 * sight, so the failure mode that matters is not being wrong — it's sounding
 * like a language model. "It's worth noting that this claim plays a crucial
 * role" costs the reader a second and returns nothing.
 *
 * So the rules live here, in one module, in two forms:
 *
 *   HOUSE_STYLE — the prose version, composed into the MCP initialize
 *     handshake, every review brief, the headless run preamble, and the
 *     annotation-reply prompt, so every agent is told before it writes.
 *   RULES + lintProse — the executable version, run over the text of every
 *     agent-authored write before it lands, so an agent that was told and
 *     wrote it anyway gets the note back with the offending span underlined.
 *
 * The catalogue is adapted from Simon Willison's llm-cliché-highlighter
 * (https://github.com/simonw/tools/blob/main/llm-cliche-highlighter.html),
 * itself partly drawn from Wikipedia's "Signs of AI writing". Three of its
 * patterns are deliberately NOT ported — colon-into-a-triple, "X is dead",
 * and the stranded-auxiliary contrast — because each fires constantly on
 * legitimate short technical notes, and a check that cries wolf gets worked
 * around rather than obeyed. Five are added that the original has no reason
 * to carry but a margin note does: preamble, flattery, hedge stacks, tidy
 * closers, and the em dash used as a drum roll.
 *
 * What is NOT linted, by design: transcription (create_note_card digitizes
 * the user's own handwriting) and reference fields (bibliographic facts).
 * Neither is the agent's writing, so neither is the agent's to clean up.
 */

/**
 * `any` rules apply to every string, down to a two-word section label.
 * `multi` rules are shapes that only exist across sentences — echoes,
 * stacked questions, repeated openers — so they run only on text that has
 * more than one sentence (a verdict, a chat reply), never on a one-liner.
 */
export type StyleScope = 'any' | 'multi'

export interface StyleSpan {
  start: number
  end: number
}

export interface StyleRule {
  /** Kebab id, shown in the rejection so the agent can name what it hit. */
  id: string
  /** One line: what this bans, and what to do instead. */
  why: string
  scope: StyleScope
  find(text: string): StyleSpan[]
}

export interface StyleHit {
  ruleId: string
  why: string
  start: number
  end: number
  /** The offending span, verbatim. */
  text: string
}

// ---------------------------------------------------------------------------
// Finders
// ---------------------------------------------------------------------------

function regexFinder(re: RegExp): (text: string) => StyleSpan[] {
  return (text) => {
    const spans: StyleSpan[] = []
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || !m[0].length) continue
      spans.push({ start: m.index, end: m.index + m[0].length })
    }
    return spans
  }
}

const CHAIN_BODY = String.raw`[^,.;:!?\n–—…]*`
const CHAIN_SEP = String.raw`(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+|\s*[;&–—]\s*(?:and\s+|or\s+)?|\s+-{1,2}\s+)`

/**
 * "No fluff, no filler, no jargon." — two or more items in a row sharing the
 * same negating head. The shape reads as rhythm standing in for content.
 */
function chainFinder(head: string): (text: string) => StyleSpan[] {
  const item = head + CHAIN_BODY
  const chain = new RegExp(String.raw`\b${item}(?:${CHAIN_SEP}${item})+`, 'gi')
  return (text) => {
    const spans: StyleSpan[] = []
    for (const m of text.matchAll(chain)) {
      if (m.index === undefined) continue
      let end = m.index + m[0].length
      while (end > m.index && /\s/.test(text[end - 1])) end -= 1
      spans.push({ start: m.index, end })
    }
    return spans
  }
}

/** Two or more questions fired in a row, the later ones usually fragments. */
function questionChainFinder(text: string): StyleSpan[] {
  const spans: StyleSpan[] = []
  for (const m of text.matchAll(/[^.!?\n]+\?(?:\s+[^.!?\n]+\?)+/g)) {
    if (m.index === undefined) continue
    let start = m.index
    while (start < m.index + m[0].length && /\s/.test(text[start])) start += 1
    spans.push({ start, end: m.index + m[0].length })
  }
  return spans
}

// Repeating a pronoun or article across sentences is just ordinary prose.
const ANAPHORA_SKIP =
  /^(?:i|it|the|a|an|this|that|we|you|they|he|she|there|but|and|so|in|as|if|my|his|her|their|its|these|those|for|at|on|of|to|is|was)$/i

/** Three or more consecutive sentences opening on the same word. */
function anaphoraFinder(text: string): StyleSpan[] {
  const sents: { start: number; end: number; head: string }[] = []
  for (const m of text.matchAll(/[^.!?\n]+[.!?]/g)) {
    if (m.index === undefined) continue
    const w = m[0].match(/[A-Za-z'’-]+/)
    if (!w) continue
    sents.push({ start: m.index + m[0].indexOf(w[0]), end: m.index + m[0].length, head: w[0].toLowerCase() })
  }
  const spans: StyleSpan[] = []
  let i = 0
  while (i < sents.length) {
    let j = i
    while (j + 1 < sents.length && sents[j + 1].head === sents[i].head && sents[j + 1].start - sents[j].end < 4) j += 1
    const run = j - i + 1
    if (run >= 3 && !ANAPHORA_SKIP.test(sents[i].head)) {
      spans.push({ start: sents[i].start, end: sents[j].end })
      i = j + 1
    } else i += 1
  }
  return spans
}

/**
 * Consecutive sentences built on the same skeleton — "A shopping cart is an
 * object in the system. A chat room is an object in the system."
 */
function echoFinder(text: string): StyleSpan[] {
  const grams = (s: string, n: number) => {
    const w = s.toLowerCase().match(/[a-z0-9'’-]+/g) || []
    const out = new Set<string>()
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
    return out
  }
  const sents: { start: number; end: number; text: string }[] = []
  for (const m of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    if (m.index === undefined) continue
    if ((m[0].match(/\S+/g) || []).length >= 4) {
      sents.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    }
  }
  const spans: StyleSpan[] = []
  let i = 0
  while (i < sents.length) {
    let j = i
    let shared: string | null = null
    while (j + 1 < sents.length) {
      if (sents[j + 1].start - sents[j].end > 3) break
      const a = grams(sents[j].text, 4)
      const b = grams(sents[j + 1].text, 4)
      const common = [...a].filter((g) => b.has(g))
      if (!common.length) break
      shared = common.sort((x, y) => y.length - x.length)[0]
      j += 1
    }
    if (j > i && shared) {
      let end = sents[j].end
      while (end > sents[i].start && /\s/.test(text[end - 1])) end -= 1
      spans.push({ start: sents[i].start, end })
      i = j + 1
    } else i += 1
  }
  return spans
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const RULES: StyleRule[] = [
  // --- Added for Elves: the tells that ruin a margin note specifically ------
  {
    id: 'preamble',
    why: 'Throat-clearing before the note. Delete the run-up and start at the thing itself.',
    scope: 'any',
    find: regexFinder(
      /(?:^|\n)\s*(?:I\s+(?:noticed|noted|think|feel|wonder|see|suspect|would\s+(?:say|argue|note|flag))\b|(?:It|This)\s+(?:seems|feels|appears|looks)\s+(?:like|as\s+if|to\s+be)\b|One\s+(?:thing|note|small\s+thing)\b|Just\s+(?:a\s+(?:note|thought|flag)|flagging)\b|(?:You\s+(?:might|may|could)\s+(?:want\s+to\s+)?)?consider(?:ed)?\s+(?:adding|whether|making|reframing)\b|A\s+(?:small|quick|minor)\s+(?:note|point|thought)\b)/gi,
    ),
  },
  {
    id: 'flattery',
    why: 'Praise in the margin. The user did not ask to be flattered; say the thing.',
    scope: 'any',
    find: regexFinder(
      /\b(?:great|good|excellent|interesting|fascinating|nice|strong|lovely)\s+(?:question|point|catch|observation|idea|instinct|work)\b|\byou(?:['’]re|\s+are)\s+(?:absolutely\s+|completely\s+|quite\s+)?right\b|\bI\s+(?:love|really\s+like)\s+(?:this|that|how)\b|\b(?:this|that)\s+is\s+(?:a\s+)?(?:really\s+|very\s+)?(?:great|excellent|fantastic|wonderful)\b/gi,
    ),
  },
  {
    id: 'hedge-stack',
    why: 'Hedges stacked on hedges. Keep at most one, or drop them and commit.',
    scope: 'any',
    find: regexFinder(
      /\b(?:perhaps|maybe|possibly|arguably|somewhat|slightly|fairly|rather|relatively|a\s+bit|a\s+little|kind\s+of|sort\s+of|might|seems?|appears?|potentially|generally|typically)\b(?:\s+\w+){0,2}?\s+\b(?:perhaps|maybe|possibly|arguably|somewhat|slightly|fairly|rather|relatively|a\s+bit|a\s+little|kind\s+of|sort\s+of|might|seems?|appears?|potentially|generally|typically)\b/gi,
    ),
  },
  {
    id: 'tidy-closer',
    why: 'A summary bow on the end. A margin note has nothing to summarise.',
    scope: 'any',
    find: regexFinder(
      // Split in two: the comma-terminated openers can't carry a trailing \b,
      // since a boundary needs a word character on the far side of the comma.
      /\b(?:in\s+short|in\s+conclusion|to\s+sum\s+up|all\s+in\s+all|at\s+the\s+end\s+of\s+the\s+day|the\s+bottom\s+line\s+is|in\s+essence)\b|\b(?:ultimately|overall|in\s+summary|to\s+conclude)\s*,/gi,
    ),
  },
  {
    id: 'em-dash-reveal',
    why: 'An em dash used as a drum roll before the point. Say the point in the first clause.',
    scope: 'any',
    find: regexFinder(
      // Only the *definite* reveal: "— and that's the real problem". An em dash
      // into an indefinite noun phrase ("— this is a diagram") is ordinary
      // apposition and the most common shape a good note actually takes.
      /[–—]\s*(?:and\s+)?(?:(?:that(?:['’]s|\s+is)|this\s+is|which\s+is|it['’]s)\s+the\b|the\s+(?:real|whole|point|thing)\b|here(?:['’]s|\s+is)\s+(?:the|why|what)\b)/gi,
    ),
  },

  // --- Rhetorical tics (llm-cliché-highlighter) -----------------------------
  {
    id: 'staged-reveal',
    why: 'A stage-managed reveal. Skip the curtain and state it.',
    scope: 'any',
    find: regexFinder(
      /\bhere(?:['’]s|\s+is)\s+(?:the|a|my|one)\s+(?:twist|thing|catch|kicker|rub|problem|first|second|third|next|real|best|worst|surprising|interesting|key|important)\b[\w\s-]{0,20}[:.]|\bthe\s+punchline(?:\s+(?:is|was|being)\b|\s*[:?])/gi,
    ),
  },
  {
    id: 'turns-out',
    why: '"Turns out" bolted to a tidy conclusion. Report what happened.',
    scope: 'any',
    find: regexFinder(/(?:^|[.!?–—]\s+|\n)Turns\s+out\b|\bit\s+turns\s+out\s+that\b/gi),
  },
  {
    id: 'performative-honesty',
    why: 'Sincerity announced rather than demonstrated. Be blunt instead of saying you will be.',
    scope: 'any',
    find: regexFinder(
      /\bI\s+(?:will\s+not|won['’]t)\s+pretend\b|\b(?:I['’]ll|let['’]s|to)\s+be\s+(?:honest|clear|blunt|real)\b|(?:^|[.!?–—]\s+|\n)(?:Honestly|Look|Truthfully|Frankly)\s*,/gi,
    ),
  },
  {
    id: 'no-chain',
    why: 'Chained negations as rhythm ("no fluff, no filler"). Say what it is, once.',
    scope: 'any',
    find: chainFinder(String.raw`no[-\s]`),
  },
  {
    id: 'did-not-chain',
    why: 'Chained "did not" items. One negation carries it.',
    scope: 'any',
    find: chainFinder(String.raw`(?:did\s+not|didn['’]t)\s`),
  },
  {
    id: 'dont-verb-it',
    why: '"Don\'t call it X. Call it Y." — a swap dressed as a revelation.',
    scope: 'any',
    find: regexFinder(
      /\b(?:do\s+not|don['’]t)\s+(?:just\s+|simply\s+|merely\s+)?(\w+)(?:\s+(?:of|about|at|on|for|with|to))?\s+it\b[^.!?\n]*?[.!?;,:–—]['"”’]*\s*(?:just\s+|simply\s+|merely\s+)?\1(?:\s+(?:of|about|at|on|for|with|to))?\s+it\b/gi,
    ),
  },
  {
    id: 'the-whole-point',
    why: '"That\'s the whole point / the entire game." Name the point instead of labelling it one.',
    scope: 'any',
    find: regexFinder(
      /(?:\b(?:is|was|are|were)|['’]s)\s+the\s+(?:whole|entire)\b(?:\s+\w+)?|\bhere(?:['’]s|\s+is)\s+the\s+whole\b(?:\s+\w+)?|\bthe\s+entire\s+[\w'’-]+(?:\s+[\w'’-]+){0,4}?\s+(?:is|was|are|were)\b/gi,
    ),
  },
  {
    id: 'not-nothing',
    why: '"That\'s not nothing." Say what it is.',
    scope: 'any',
    find: regexFinder(/\b(?:that|this|it|which)(?:['’]s|\s+(?:is|was))\s+not\s+nothing\b/gi),
  },
  {
    id: 'therapist-voice',
    why: 'The therapist register: "sit with that", "worth naming".',
    scope: 'any',
    find: regexFinder(
      /\bsit(?:s|ting)?\s+with\s+(?:that|this|it|(?:the|your)\s+(?:discomfort|feelings?|tension|weight|uncertainty|ambiguity|grief|silence|unease))\b(?:\s+for\s+a\s+\w+)?|(?:\b(?:is|are|was|were|feels?|felt|seems?|seemed)|['’]s)\s+(?:\w+\s+){0,2}?worth\s+naming\b(?!\s+names\b)|\bworth\s+naming\s*:/gi,
    ),
  },
  {
    id: 'you-already-know',
    why: 'Telling the reader they already know. Either say it or cut it.',
    scope: 'any',
    find: regexFinder(
      /\byou\s+already\s+knows?\s+(?:the\s+answer|what|how|why|this|that|it|who|where)\b|\byou\s+already\s+knows?\b(?![ \t]+\w)/gi,
    ),
  },
  {
    id: 'thats-the-part',
    why: 'Gesturing at a detail instead of naming it ("that\'s the part that matters").',
    scope: 'any',
    find: regexFinder(
      /\b(?:that|this|it)(?:['’]s|\s+(?:is|was))\s+the\s+part\b|\bthe\s+part\s+that\s+(?:makes|made|gets|got|keeps|kept)\s+(?:me|you|us|it)\b|\bmy\s+favou?rite\s+part\s+of\b/gi,
    ),
  },
  {
    id: 'only-x-i-trust',
    why: 'The narrowing superlative reveal ("the only X that matters").',
    scope: 'any',
    find: regexFinder(
      /\bthe\s+only\s+[\w'’-]+(?:\s+[\w'’-]+){0,2}?\s+(?:I|you|we|it|he|she|they)\s+(?:trust|need|needs|care|want|wants|use|uses|believe)\b|\bthe\s+only\s+[\w'’-]+\s+that\s+(?:matters|counts|works|survives)\b/gi,
    ),
  },
  {
    id: 'take-my-word',
    why: 'The stock invitation to verify. Just cite the thing.',
    scope: 'any',
    find: regexFinder(
      /\b(?:you\s+)?(?:do\s+not|don['’]t)\s+(?:have\s+to\s+)?take\s+my\s+word\s+for\s+(?:it|any\s+of\s+(?:it|this|that))\b/gi,
    ),
  },
  {
    id: 'is-real-and',
    why: '"The X is real, and …" — asserting weight instead of showing it.',
    scope: 'any',
    find: regexFinder(
      /\bis\s+(?:(?:the|a)\s+real\b(?![\s-]+(?:estate|time|life|world|quick)\b)[^.!?\n]*?\b(?:and|not)\s+it\b|real\b(?![\s-]+(?:estate|time|life|world|quick)\b)[^.!?\n]*?\b(?:and|not)\b)/gi,
    ),
  },
  {
    id: 'why-it-mattered',
    why: 'Retroactively assigning significance ("that\'s why X mattered").',
    scope: 'any',
    find: regexFinder(
      /\b(?:that|this)(?:['’]s|\s+(?:is|was))\s+why\b[^.!?\n]{0,80}?\b(?:matter(?:s|ed)?|count(?:s|ed)?)\b/gi,
    ),
  },
  {
    id: 'fits-in-your-head',
    why: 'Dev-blog boilerplate: "it just works", "batteries included", "fits in your head".',
    scope: 'any',
    find: regexFinder(
      /\b(?:hold|fit|fits|holds|held)\s+(?:it\s+)?in\s+your\s+head\b|\bbatteries[-\s]included\b|\bit\s+just\s+works\b|\bzero[-\s]config(?:uration)?\b|\bsane\s+defaults\b/gi,
    ),
  },

  // --- Signs of AI writing (Wikipedia, via llm-cliché-highlighter) ----------
  {
    id: 'ai-vocab',
    why: 'Vocabulary language models reach for and people do not. Use the ordinary word.',
    scope: 'any',
    find: regexFinder(
      /\b(?:delv(?:e|es|ed|ing)|tapestr(?:y|ies)|meticulous(?:ly)?|pivotal|intricate(?:ly)?|intricacies|interplay|underscor(?:e|es|ed|ing)|garner(?:s|ed|ing)?|bolster(?:s|ed|ing)?|vibrant|bustling|multifaceted|seamless(?:ly)?|commendable|ever-evolving|myriad|nuanced|robust|leverage|utilize|utilise|holistic|paradigm)\b/gi,
    ),
  },
  {
    id: 'negative-parallelism',
    why: '"Not just X, but Y" / "it\'s not X — it\'s Y". State Y.',
    scope: 'any',
    find: regexFinder(
      /\bnot\s+(?:just|only|merely|simply)\s+[^.!?\n;]*?\bbut(?:\s+also)?\b|\b(?:it|this|that)(?:['’]s|\s+(?:is|was))\s+not\s+[^.!?\n,;—–]{1,60}[,;—–]\s*(?:it|this|that)(?:['’]s|\s+(?:is|was))\b/gi,
    ),
  },
  {
    id: 'didactic-hedge',
    why: 'Announcing that something is worth noting instead of noting it.',
    scope: 'any',
    find: regexFinder(
      /\bit(?:['’]s|\s+(?:is|was))\s+(?:also\s+)?(?:important|worth|crucial|essential|vital)\s+(?:to\s+(?:note|remember|understand|recognize|recognise|mention|pause|consider|ask)|noting|mentioning|remembering|pausing|considering|asking)\b(?:\s+that\b)?|\bit\s+should\s+be\s+noted\b/gi,
    ),
  },
  {
    id: 'testament',
    why: '"Stands as a testament to …" — inflation in place of description.',
    scope: 'any',
    find: regexFinder(
      /\b(?:stand|stands|stood|serve|serves|served|standing|serving)\s+as\s+(?:a|an)\s+(?:\w+\s+)?(?:testament|reminder)\b|\b(?:is|was|are|were|remain|remains)\s+a\s+(?:\w+\s+)?testament\s+to\b/gi,
    ),
  },
  {
    id: 'inflated-role',
    why: '"Plays a crucial role in …". Say what it does.',
    scope: 'any',
    find: regexFinder(
      /\bplay(?:s|ed|ing)?\s+(?:a|an)\s+(?:\w+\s+)?(?:crucial|pivotal|vital|key|significant|central|critical|important)\s+role\b/gi,
    ),
  },
  {
    id: 'scene-setting',
    why: 'Boilerplate scene-setting: "the ever-evolving landscape", "in today\'s fast-paced world".',
    scope: 'any',
    find: regexFinder(
      /\b(?:ever-)?(?:evolving|changing|shifting)\s+landscape\b|\bin\s+today['’]s\s+(?:fast-paced|ever-changing|ever-evolving|digital|modern|competitive)\s+\w+/gi,
    ),
  },
  {
    id: 'vague-authority',
    why: 'Unnamed authorities ("experts argue", "studies show"). Name the source or drop the claim.',
    scope: 'any',
    find: regexFinder(
      /\b(?:many|some|several|most|numerous)?\s*(?:experts|critics|observers|scholars|analysts|commentators)\s+(?:have\s+|often\s+|widely\s+)?(?:argu(?:e|es|ed)|not(?:e|es|ed)|suggest(?:s|ed)?|believ(?:e|es|ed)|agree[ds]?|contend(?:s|ed)?|observ(?:e|es|ed)|caution(?:s|ed)?|claim(?:s|ed)?|cit(?:e|es|ed)|point(?:s|ed)?\s+out)\b|\bindustry\s+reports?\s+(?:suggest|indicate|show)\w*\b|\bstudies\s+(?:show|suggest|indicate)\b/gi,
    ),
  },
  {
    id: 'challenges-outlook',
    why: 'The challenges-and-outlook formula: "despite these challenges", "time will tell".',
    scope: 'any',
    find: regexFinder(
      /\bdespite\s+(?:these|those|such|its|their|the|numerous|significant|ongoing)\s+(?:\w+\s+)?challenges\b|\bfac(?:e|es|ed|ing)\s+(?:several|numerous|many|significant|various|a\s+number\s+of)\s+challenges\b|\bchallenges\s+remain\b|\bremains\s+to\s+be\s+seen\b|\b(?:only\s+)?time\s+will\s+tell\b/gi,
    ),
  },
  {
    id: 'participle-tail',
    why: 'Analysis bolted onto a sentence end (", highlighting the importance of …"). Cut the tail.',
    scope: 'any',
    find: regexFinder(
      /,\s+(?:highlighting|underscoring|emphasizing|emphasising|showcasing|reflecting|demonstrating|illustrating|signaling|signalling|solidifying|cementing|reinforcing|underlining)\s+(?:its|his|her|their|our|the|a|an|how|that|what|both)\b[^.!?\n]*/gi,
    ),
  },
  {
    id: 'promotional',
    why: 'Travel-brochure tone: "nestled in", "hidden gem", "boasts a".',
    scope: 'any',
    find: regexFinder(
      /\bnestled\s+(?:in|on|among|between|along|at)\b|\bin\s+the\s+heart\s+of\b|\brich\s+(?:cultural\s+|historical\s+)?(?:heritage|history|tapestry)\b|\bhidden\s+gem\b|\bmust-(?:visit|see|try|read)\b|\bbreathtaking\b|\bboasts?\s+(?:a|an|the)\b|\bstunning\s+(?:views?|scenery|architecture|backdrop)\b/gi,
    ),
  },
  {
    id: 'chatbot-leftovers',
    why: 'Debris pasted from a chat session.',
    scope: 'any',
    find: regexFinder(
      /\bas\s+an\s+ai(?:\s+language)?\s+model\b|\bas\s+of\s+my\s+last\s+(?:update|training)\b|\bknowledge\s+cutoff\b|\bI\s+(?:cannot|can['’]t|do\s+not|don['’]t)\s+(?:browse\s+the\s+internet|access\s+real-?time)\b|contentReference|oaicite|turn0(?:search|news|image)\d*|attributableIndex|utm_source=/gi,
    ),
  },

  // --- Shapes that only exist across sentences ------------------------------
  {
    id: 'stacked-questions',
    why: 'Questions fired in a row. Ask the one that matters.',
    scope: 'multi',
    find: questionChainFinder,
  },
  {
    id: 'repeated-openers',
    why: 'Three sentences opening on the same word. Vary them.',
    scope: 'multi',
    find: anaphoraFinder,
  },
  {
    id: 'echoing-sentences',
    why: 'Consecutive sentences built on the same skeleton. Say it once.',
    scope: 'multi',
    find: echoFinder,
  },
]

export const RULE_IDS: string[] = RULES.map((r) => r.id)

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

/**
 * Blank out quoted spans, preserving offsets.
 *
 * An agent quoting the user's own prose back to them is doing its job — the
 * Trimmer is explicitly told it may quote a shorter phrasing, and any comment
 * may quote the line it is about. Those words are the user's, and the check
 * has no business grading them. So double-quoted runs (straight or curly) are
 * masked with spaces before matching: the offsets of everything else stay
 * exact, and nothing inside the quotes can match. Single quotes are left alone
 * because apostrophes would swallow half the note.
 */
export function maskQuotes(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”/g, (m) => ' '.repeat(m.length))
}

function sentenceCount(text: string): number {
  const parts = text.split(/[.!?]+[\s"'”’]|\n+/).filter((s) => s.trim().length > 0)
  return Math.max(1, parts.length)
}

export interface LintOptions {
  /**
   * Force multi-sentence rules on or off. Left unset, they run when the text
   * actually has more than one sentence.
   */
  multi?: boolean
}

/**
 * Every house-style rule this text breaks, in the order the offences appear.
 * At most one hit per rule — a note that says "delve" three times has one
 * vocabulary problem, and three carets under the same word teach nothing extra.
 */
export function lintProse(text: string, options: LintOptions = {}): StyleHit[] {
  if (!text || !text.trim()) return []
  const masked = maskQuotes(text)
  const multi = options.multi ?? sentenceCount(masked) > 1
  const hits: StyleHit[] = []
  for (const rule of RULES) {
    if (rule.scope === 'multi' && !multi) continue
    const [first] = rule.find(masked)
    if (!first) continue
    hits.push({
      ruleId: rule.id,
      why: rule.why,
      start: first.start,
      end: first.end,
      text: text.slice(first.start, first.end),
    })
  }
  return hits.sort((a, b) => a.start - b.start)
}

/** Longest single-line diagram we will draw carets under. */
const CARET_LIMIT = 220

/**
 * The rejection an agent gets back: the text, carets under each offence, and
 * one line per rule saying what to do instead. Written to be read by whatever
 * wrote the note, so it names the fix rather than scolding.
 */
export function formatStyleRejection(field: string, text: string, hits: StyleHit[]): string {
  const plural = hits.length === 1 ? 'rule' : 'rules'
  const lines = [`Rejected: this ${field} hits ${hits.length} house-style ${plural}.`, '']

  if (text.length <= CARET_LIMIT && !/\s\s|\n/.test(text)) {
    let carets = ''
    for (const h of hits) {
      if (h.start < carets.length) continue
      carets += ' '.repeat(h.start - carets.length) + '^'.repeat(Math.max(1, h.end - h.start))
    }
    lines.push(`  ${text}`, `  ${carets}`, '')
  }

  for (const h of hits) {
    lines.push(`  · ${h.ruleId} — "${h.text.trim()}"`)
    lines.push(`      ${h.why}`)
  }
  lines.push('', 'Rewrite it plainly and call the tool again. Text inside "double quotes" is')
  lines.push('exempt, so quote the user\'s own words rather than paraphrasing them into slop.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The prose version, for prompts
// ---------------------------------------------------------------------------

/**
 * The rules as an agent is told them, before it writes anything. Composed into
 * the MCP initialize handshake, every review brief, the headless preamble, and
 * the annotation-reply prompt — one string, so the instructions an agent reads
 * and the check that rejects its note can never drift apart.
 */
export const HOUSE_STYLE = `HOUSE STYLE — every word you write into this canvas

Write the way an editor writes in pencil: the thing itself, nothing around it. These are not preferences. A write containing any of the following is REJECTED by the server and handed back for you to rewrite.

- Throat-clearing: "I noticed that", "It seems like", "One thing to flag", "You might consider adding", "Just a note".
- Flattery: "Great question", "You're absolutely right", "Good catch", "I love this".
- Model vocabulary: delve, tapestry, meticulous, pivotal, intricate, interplay, underscore, garner, bolster, vibrant, multifaceted, seamless, ever-evolving, commendable, myriad, nuanced, robust, leverage, utilize, holistic, paradigm.
- Inflation: "plays a crucial role", "stands as a testament to", ", highlighting the importance of", "the ever-evolving landscape".
- Negative parallelism: "not just X but Y", "it's not X — it's Y".
- Didactic hedging: "it's worth noting that", "it's important to remember".
- Staged reveals: "Here's the thing", "Turns out", "the punchline is", and an em dash used as a drum roll ("— and that's the real problem").
- Chained negations for rhythm: "No fluff, no filler, no jargon."
- Announced sincerity: "Let's be honest", "To be clear", "Honestly,".
- Vague authority: "experts argue", "studies show", "some critics have noted".
- Tidy closers: "In short", "Ultimately", "At the end of the day", "Overall".
- Stacked hedges: "perhaps somewhat unclear", "it might arguably be".
- Therapist voice: "sit with that", "worth naming", "that's not nothing".
- Dev-blog boilerplate: "it just works", "batteries included", "fits in your head".
- Chatbot debris: "as an AI language model", "as of my last update".

Across more than one sentence, also rejected: two questions fired in a row, three sentences opening on the same word, and consecutive sentences built on the same skeleton.

Instead: name the specific thing in the specific card, in the plainest words that carry it. "The 73% figure has no source" beats "It's worth noting that this statistic would benefit from a citation." Vary your sentence lengths, trust the reader to get a metaphor without you explaining it, and never end on a line that sounds like a pull-quote.

Quoting the user is exempt: anything inside "double quotes" is skipped by the check, so quote their own words rather than paraphrasing them.`

/**
 * The short version, for prompts that are backed by the repair pass.
 *
 * HOUSE_STYLE is ~620 tokens and rides in the system prompt of every call in an
 * agent's loop, where prompt caching charges it again (at a tenth of the rate)
 * on every turn. That is the right price when the prompt is the ONLY defence.
 * Where a write also passes through the style gate — which now repairs a note
 * locally before it ever rejects one — the prompt only has to aim the agent in
 * the right direction; the gate catches the rest for free. So gated surfaces
 * get this ~150-token version, and the full text is reserved for the one
 * surface nothing can catch: an annotation reply, which reaches the user as
 * chat prose without passing through any tool.
 */
export const HOUSE_STYLE_BRIEF = `HOUSE STYLE: write like an editor's pencil note — the thing itself, nothing around it. No throat-clearing ("I noticed that", "it's worth noting"), no flattery ("great question"), no model vocabulary (delve, intricate, interplay, seamless, crucial, nuanced, robust, leverage, myriad), no "not just X but Y", no staged reveals ("here's the thing", "turns out"), no tidy closers ("in short", "ultimately", "overall"), no stacked hedges ("perhaps somewhat"), no vague authority ("experts argue", "studies show"). Name the specific thing in the plainest words that carry it. Every note you write is checked: a small local model strips what it can, and anything left is handed back for you to rewrite. Quoting the user in "double quotes" is exempt from the check.`

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * The instruction handed to the local repair model.
 *
 * Written for a small model (llama3.2), so it is blunt and repetitive where a
 * larger model would need one line. The whole job is DELETION and the smallest
 * possible substitution: the note's observation is the reviewing agent's, and
 * the repair pass exists to strip a cliché off it, never to have a second model
 * re-think what the note says.
 */
export function buildRepairPrompt(text: string, hits: StyleHit[]): string {
  const offences = hits.map((h) => `- Remove "${h.text.trim()}" — ${h.why}`).join('\n')
  return `You are copy-editing one short editorial note. Remove the cliché phrases listed below and change NOTHING else.

The note:
${text}

Remove:
${offences}

Rules:
- Delete the listed phrases. Keep every other word exactly as it is.
- Fix only what deletion breaks: capitalise the new first word, keep the final full stop.
- Keep every number, name, and anything in "double quotes" exactly as written.
- Do NOT add new ideas, opinions, explanations, or preambles.
- Do NOT make it longer. One sentence.
- Reply with ONLY the corrected sentence. No quotes around it, no commentary.

Corrected sentence:`
}

/**
 * The instruction for repairing a CHAT REPLY, as opposed to a margin note.
 *
 * Different job, different prompt. A note is one sentence and the repair is
 * nearly always a deletion; a reply is several sentences of prose that has to
 * survive intact while a few phrases come out of it. The overriding risk here
 * is a small model "helpfully" summarising, so the instruction leans hard on
 * keeping everything and the acceptance check enforces a length floor.
 */
export function buildReplyRepairPrompt(text: string, hits: StyleHit[]): string {
  const offences = [...new Set(hits.map((h) => `"${h.text.trim()}"`))].join(', ')
  return `You are copy-editing a message someone wrote. Remove the cliché phrases and change nothing else.

The message:
${text}

Remove these phrases: ${offences}

Rules:
- Keep EVERY point, fact, number, name, file path and quotation. This is not a summary.
- Keep roughly the same length. Do not condense. Do not drop sentences.
- Delete only the listed phrases, and repair the grammar where deleting one leaves a gap.
- Keep the same voice and point of view: it is a message written TO the reader.
- Do not add new ideas, opinions, or a preamble. Do not comment on your edits.
- Reply with ONLY the edited message.

Edited message:`
}

/**
 * The leash on a chat-reply repair.
 *
 * Looser than acceptRepair in one way and stricter in another. Looser: a reply
 * may legitimately still break a rule after editing — several sentences can
 * carry several offences and a small model rarely gets all of them — so the
 * bar is that it must be BETTER, not perfect. Stricter: there is a length
 * floor, because the failure mode that actually shows up is the model quietly
 * summarising four paragraphs into one and losing what the user asked for.
 *
 * Nothing here rejects into an error. This path is fail-open: a repair that
 * misses the bar is discarded and the agent's original words are saved, which
 * is exactly what happens today.
 */
export function acceptReplyRepair(original: string, repaired: string): RepairVerdict {
  const clean = repaired.trim()
  if (!clean) return { ok: false, reason: 'empty' }

  const before = words(original).length
  const after = words(clean).length
  // The floor is derived, not guessed. We know exactly how many words we asked
  // the model to delete, so what should survive is everything else — minus a
  // little slack for the rewording that closing a gap needs. A flat percentage
  // cannot do this job: on a long reply the clichés are a rounding error, while
  // on a two-sentence one they can be a quarter of the words, and any single
  // threshold is wrong at one end or the other.
  const deletable = lintProse(original).reduce((n, h) => n + words(h.text).length, 0)
  if (after < (before - deletable) * 0.85) return { ok: false, reason: 'too-short' }
  if (after > before * 1.05) return { ok: false, reason: 'longer' }

  for (const n of original.match(/\d[\d.,:%]*/g) ?? []) {
    if (!clean.includes(n)) return { ok: false, reason: 'lost-a-number' }
  }
  for (const q of original.match(/"[^"]*"|“[^”]*”/g) ?? []) {
    if (!clean.includes(q)) return { ok: false, reason: 'lost-a-quote' }
  }

  const beforeWords = contentWords(original)
  const afterWords = contentWords(clean)
  const invented = [...afterWords].filter((w) => !beforeWords.has(w)).length
  if (afterWords.size > 0 && invented / afterWords.size > 0.15) {
    return { ok: false, reason: 'invented-content' }
  }

  // The whole point: it has to be an improvement, even if not a clean sweep.
  const wasHits = lintProse(original).length
  const nowHits = lintProse(clean).length
  if (nowHits >= wasHits) return { ok: false, reason: 'still-breaks-the-rules' }
  return { ok: true }
}

/** Why a repair was thrown away. Surfaced in logs so a bad model is visible. */
export type RepairRejection =
  | 'empty'
  | 'multi-line'
  | 'longer'
  | 'too-short'
  | 'lost-a-number'
  | 'lost-a-quote'
  | 'invented-content'
  | 'broken-seam'
  | 'title-cased'
  | 'still-breaks-the-rules'

export type RepairVerdict = { ok: true } | { ok: false; reason: RepairRejection }

const words = (s: string) => s.match(/\S+/g) ?? []

/**
 * Three or more capitalised words past the first, none of which look like a
 * proper noun's neighbours. Crude on purpose: it only has to separate ordinary
 * prose from Title Case, and a note that really is mostly proper nouns is rare
 * enough that falling back to a rejection there costs nothing.
 */
function titleCased(s: string): boolean {
  const w = words(s).slice(1).filter((x) => /^[A-Za-z]/.test(x))
  if (w.length < 3) return false
  const caps = w.filter((x) => /^[A-Z]/.test(x)).length
  return caps >= 3 && caps / w.length > 0.6
}
// Curly and straight apostrophes must compare equal, or "that's" and "that’s"
// read as two different words and an honest repair looks like an invented one.
const contentWords = (s: string) =>
  new Set(s.toLowerCase().replace(/[’]/g, "'").match(/[a-z0-9']+/g) ?? [])

/**
 * The short leash on the repair model.
 *
 * A local model is trusted to strike a phrase out, not to have an opinion. The
 * card that ends up on the canvas still carries the reviewing agent's
 * authorship mark, so a repair that changes what the note SAYS would put words
 * under that mark which the agent never wrote. These checks are what make the
 * difference between copy-editing and ghostwriting, and anything that fails
 * them is discarded — the gate then rejects to the agent as it did before, so
 * the cost of a bad local model is a slower path, never a wrong note.
 */
export function acceptRepair(original: string, repaired: string): RepairVerdict {
  const clean = repaired.trim()
  if (!clean) return { ok: false, reason: 'empty' }
  if (/\n/.test(clean)) return { ok: false, reason: 'multi-line' }

  // A repair deletes; it never waffles. One word of slack covers a contraction
  // being spelled out when the phrase in front of it goes.
  if (words(clean).length > words(original).length + 1) return { ok: false, reason: 'longer' }
  if (words(clean).length < 3) return { ok: false, reason: 'too-short' }

  // The load-bearing specifics. "The 73% figure has no source" is worth saying;
  // "The figure has no source" is not the same note.
  for (const n of original.match(/\d[\d.,:%]*/g) ?? []) {
    if (!clean.includes(n)) return { ok: false, reason: 'lost-a-number' }
  }
  for (const q of original.match(/"[^"]*"|“[^”]*”/g) ?? []) {
    if (!clean.includes(q)) return { ok: false, reason: 'lost-a-quote' }
  }

  // Deleting words is the point; inventing them is the risk. Almost every real
  // repair invents NOTHING — striking "It's worth noting that" off the front
  // leaves the rest untouched. A word or two of slack lets a genuine
  // substitution through ("delves into" -> "covers") while catching the failure
  // this is really here for: the model paraphrasing instead of deleting. Left
  // at a bare ratio, "plays a crucial role" came back as "does what is
  // necessary" — clean against every rule, vaguer than what it replaced, and
  // no longer the reviewer's observation.
  const before = contentWords(original)
  const after = contentWords(clean)
  const invented = [...after].filter((w) => !before.has(w)).length
  if (invented > 2) return { ok: false, reason: 'invented-content' }
  if (after.size > 0 && invented / after.size > 0.35) return { ok: false, reason: 'invented-content' }

  // Deletion mid-sentence strands the following clause, and a small model
  // patches the seam by capitalising it: "The claim is weak; The need for a
  // source." Clean against every rule, and not a sentence.
  if (/[;,]\s+(?:The|This|That|These|Those|A|An|It|We|You|They|There)\b/.test(clean)) {
    return { ok: false, reason: 'broken-seam' }
  }

  // Some models answer a copy-editing request by Title Casing The Whole Thing.
  // Observed from qwen2.5:7b: "The Third Card Repeats The First." Every word is
  // the original's and it passes every other check, so catch it on the shape.
  if (titleCased(clean) && !titleCased(original)) return { ok: false, reason: 'title-cased' }

  if (lintProse(clean).length) return { ok: false, reason: 'still-breaks-the-rules' }
  return { ok: true }
}
