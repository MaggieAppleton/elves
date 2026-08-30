---
name: elves-house-style
description: Use when writing any text that will appear inside the Elves app — a comment, question, floating feedback note, figure title or description, section label, review verdict, or a chat reply in the agent box or an annotation thread. Strips the phrases and structures that make writing read as machine-generated. Enforced by the server, which rejects a write that breaks these rules.
---

# Elves house style

Everything you write lands in the margin of someone's draft. A margin note is
read in one glance and trusted or ignored on the spot, so the failure that
matters is not being wrong — it is sounding like a language model. *"It's worth
noting that this claim plays a crucial role in the argument"* costs the reader a
second and gives back nothing. *"The 73% figure has no source"* costs nothing
and gives back the whole note.

**These rules are enforced, not suggested.** The Elves MCP server runs every
agent-authored string through `lintProse` (`src/model/houseStyle.ts`) before it
touches the canvas. A write that breaks a rule comes back as an error naming the
rule and underlining the span, and you rewrite and call again. Nothing
slop-shaped reaches the user's canvas.

```
add_comment → ERROR

Rejected: this comment hits 2 house-style rules.

  It's worth noting that this claim plays a crucial role.
  ^^^^^^^^^^^^^^^^^^^^^^^^          ^^^^^^^^^^^^^^^^^^^^

  · didactic-hedge — "It's worth noting that"
      Announcing that something is worth noting instead of noting it.
  · inflated-role — "plays a crucial role"
      "Plays a crucial role in …". Say what it does.
```

## The rules

HOUSE STYLE — every word you write into this canvas

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

Quoting the user is exempt: anything inside "double quotes" is skipped by the check, so quote their own words rather than paraphrasing them.

## Not enforced, still true

The gate catches phrases. It cannot catch a note that is merely limp, so these
stay your job:

- **Three sentences of the same length in a row.** Break one.
- **A paragraph that ends on a punchy one-liner.** Vary the landing.
- **Explaining your own metaphor.** Trust it.
- **Two items dressed as three.** If the third example is filler, cut it.
- **Softening a real objection into a suggestion.** If the argument is broken,
  say the argument is broken.

## What is exempt, and why

Two kinds of text are never checked, because neither is yours:

- **Transcription** (`create_note_card`) — you are digitizing the user's own
  handwriting. Their words, their voice, verbatim. Never tidy them.
- **Reference fields** (`create_reference`) — authors, venue, DOI, the source's
  own abstract. Facts, not prose.
- **A card body you edit** (`edit_card`'s `text`) — on a note card that body is
  the user's, transcribed or typed, and the tool cannot tell a note from a
  figure without a read. Its `title` is gated, since a figure's working title is
  always yours. Write new figure descriptions through `create_figure_card`,
  which is gated.

Inside a note you *are* writing, `"double-quoted"` spans are skipped too. This is
what lets the Trimmer quote a suggested phrasing and any comment quote the line
it is about. Use it: quoting the user's actual words is always better than
paraphrasing them, and the paraphrase is where slop creeps in.

## Worked rewrites

| Rejected | Rule | Write instead |
|---|---|---|
| "I noticed that the third card repeats the first." | `preamble` | "The third card repeats the first." |
| "It's worth noting this claim needs a source." | `didactic-hedge` | "This claim needs a source." |
| "Great question! The evidence is thin here." | `flattery` | "The evidence is thin here." |
| "This section delves into the intricate interplay of the two systems." | `ai-vocab` | "This section covers how the two systems interact." |
| "It's not a structure problem — it's a clarity problem." | `negative-parallelism` | "This is a clarity problem, not a structure one." |
| "Here's the thing: the middle sags." | `staged-reveal` | "The middle sags." |
| "You might consider adding emotional depth." | `preamble` | "What did it cost her?" |
| "The claim is weak, highlighting the need for evidence." | `participle-tail` | "The claim is weak. It needs evidence." |
| "This section is perhaps somewhat unclear." | `hedge-stack` | "I lost the thread at the second paragraph." |
| "Ultimately, the piece holds together." | `tidy-closer` | "The piece holds together." |
| "Despite these challenges, the argument works." | `challenges-outlook` | "The argument works." |

Notice what every rewrite does: it deletes the run-up and starts at the thing.
That is the whole technique.

## Where this lives

- `src/model/houseStyle.ts` — `HOUSE_STYLE` (this text, verbatim) and `RULES` /
  `lintProse` / `formatStyleRejection` (the check). One module, so the rules an
  agent is told and the rules the server enforces cannot drift apart.
- `mcp/index.ts` — `styleGate()`, applied to `add_comment`, `create_question`,
  `create_feedback`, `create_figure_card` (title and description),
  `create_section`, `edit_section_text`, `edit_card` (title only), and
  `complete_review`.
- `src/model/reviews.ts` — rule 6 of `SHARED_RULES`, in every review brief.
- `server/agentRun.ts` — `buildPreamble`, covering agent-box chat and
  annotation replies, which pass through no tool and so cannot be gated.
- `server/summarize/summarizer.ts` — the vocabulary ban in `SUMMARY_PROMPT`,
  for the local model that writes card gists.

The catalogue is adapted from
[Simon Willison's llm-cliché-highlighter](https://github.com/simonw/tools/blob/main/llm-cliche-highlighter.html),
itself drawing on Wikipedia's
[Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
Three of its patterns are deliberately not ported (colon-into-a-triple, "X is
dead", stranded-auxiliary contrast) because each misfires on ordinary short
technical notes, and a check that cries wolf gets worked around. Five are added
for the margin specifically: `preamble`, `flattery`, `hedge-stack`,
`tidy-closer`, `em-dash-reveal`.
