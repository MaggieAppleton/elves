# Review passes: summonable editor personalities

**Date:** 2026-07-08
**Status:** Approved design, implemented alongside this spec

## Problem

Today the only way to get a critical read of the canvas is to free-prompt an agent over MCP
("read my canvas and flag weak spots"). That has three failures:

1. **No affordance.** Kicking off a review lives entirely in the agent's chat window; the app
   itself offers no way to ask for one, so it rarely happens as part of the writing loop.
2. **No shape.** "Flag weak spots" is an unbounded ask. The agent free-associates across every
   axis of critique at once — argument, evidence, prose, structure — and the result reads as
   noise: many comments, no through-line, no sense of when the pass is *done*.
3. **No identity.** Comments arrive as an undifferentiated stream. There is no record that "a
   review happened", no overall verdict, and nothing grouping one pass's notes together.

## Core insight

A good editorial read is a *role*, not a checklist. Human editors do focused passes — a
structural edit, a line edit, a fact-check — precisely because attention is sharper when it's
narrow. The feature models that directly: you **summon a reviewer personality** to do one
bounded pass, in character, with a hard budget, ending in a short verdict.

The app's intelligence lives in whatever agent is connected over MCP — the app can't run a
review itself. So the UI affordance creates a **review request**: a small per-project record an
agent discovers and claims through MCP. The same record type also backs chat-initiated passes
("play devil's advocate on this"), so both entry points produce the same grouped, reportable
pass.

## The cast (v1)

Five personalities, chosen to be *mutually exclusive in attention* — each looks at something the
others are told to ignore, so summoning two in sequence never yields the same note twice:

| id | Name | Reads for | Comment types | Budget |
|---|---|---|---|---|
| `devils-advocate` | Devil's Advocate | the argument: objections, hidden assumptions, overreach | `counterpoint`, `weak-argument` | 6 comments, 3 questions |
| `fact-checker` | The Fact-Checker | claims leaning on evidence they don't have | `needs-evidence`, `needs-citation` | 8 comments, 0 questions |
| `trimmer` | The Trimmer | bloat: redundancy, throat-clearing, hedging | `tighten` | 8 comments, 0 questions |
| `first-reader` | The First Reader | the cold-read experience: confusion, jargon, lost threads | `unclear`, freeform | 6 comments, 3 questions |
| `architect` | The Architect | structure: order, bridges, sagging middles, figure opportunities | `structure`, `wants-figure` | 5 comments, 3 questions |

Four new comment types join the existing four: **`counterpoint`** (a specific objection the
piece must address — distinct from `weak-argument`, which says the reasoning itself fails),
**`tighten`** (compress this passage), **`unclear`** (a cold reader loses the thread here), and
**`structure`** (ordering/flow problem). Any agent may use them outside a review too.

### Rules all personalities share (composed into every brief)

- **Read the draft first** (`read_draft`), in order, like a reader — then `read_map`/`read_cards`
  for positions and detail.
- **Stay in character.** Feedback outside the personality's remit is dropped, not smuggled in as
  freeform. Another reviewer covers it; that's why there's a cast.
- **Budgets are ceilings, not quotas.** Spend comments on the strongest instances found anywhere
  in the piece, not the first N encountered. A pass that returns two sharp notes is a good pass.
- **Never re-flag.** A card with an unresolved comment of the same type is already flagged; a
  dismissed question is an answered "no".
- **Comments are margin notes**: one or two sentences, anchored in what the card actually says.
- **The pass ends with a verdict**: one to three sentences of overall read, delivered via
  `complete_review` — honest, including "this holds up" when it does.
- **Annotate only.** A review pass never moves, merges, edits, or creates cards (questions
  excepted). The Architect *describes* a better order in a comment; the user (or a separately
  asked-for reorganization) makes the move. Feedback and change are different gestures.

### The Trimmer and voice (future seam)

The Trimmer may include a suggested shorter phrasing *inside its comment*, quoted, as a
suggestion — never applied. Its brief instructs it to mirror the diction already on the canvas;
when a per-project **voice doc** exists (planned, not in this change), the brief will point at
it. The golden rule is untouched: no tool writes prose, and a suggestion in a comment is the
user's to retype or ignore.

## The review record

Reviews are **project-level metadata, not canvas content** — requesting one shouldn't be a
tldraw undo step, and the record must exist before the agent has touched the canvas. They live
in `data/projects/<id>/reviews.json` beside `project.json`, written through the same
serialized-per-path lock discipline as the canvas.

```ts
interface Review {
  id: string
  personality: PersonalityId
  status: 'pending' | 'in-progress' | 'done' | 'dismissed'
  focus: string | null        // optional user note: "just the opening section"
  requestedAt: string
  agent: string | null        // agent id that claimed it
  startedAt: string | null
  completedAt: string | null
  verdict: string | null      // the agent's 1–3 sentence overall read
  commentCount: number        // stamped at completion: comments tagged with this review's id
}
```

Lifecycle: `pending` (summoned in UI, waiting for an agent) → `in-progress` (claimed via
`start_review`) → `done` (closed via `complete_review` with a verdict). `dismissed` is the
user-only exit from any state (cancel a pending summon, or clear a finished pass from the
panel). A chat-initiated pass is born directly `in-progress`.

Comments carry a new nullable `reviewId` tying them to the pass that made them (tldraw prop
migration adds `null` to existing comments). Questions are deliberately *not* tagged in v1 —
the comment group plus verdict is the report; tagging questions adds a shape migration for
little display value.

## Server

- `GET  /projects/:id/reviews` → `{ reviews }` (newest first).
- `POST /projects/:id/reviews` `{ personality, focus?, agent? }` → create. With `agent` it is
  born `in-progress` (the chat-initiated path); without, `pending` (the UI summon).
- `POST /projects/:id/reviews/:reviewId/status` `{ status, agent?, verdict? }` → guarded
  transitions (`pending→in-progress` requires `agent`; `in-progress→done` requires `verdict`
  and stamps `commentCount` by scanning the canvas; `→dismissed` from any non-done state, or
  from `done` as "clear from panel").
- Every mutation broadcasts `{ projectId, reviews }` on the existing websocket so the panel
  updates live without polling.

## MCP surface

- **`list_reviews(project)`** — all passes with status/personality/focus/verdict. Description
  teaches the agent: pending reviews are the user's summons; check for them when starting work
  on a canvas.
- **`start_review(project, reviewId? | personality?, focus?)`** — claim a pending request (by
  id) or open an ad-hoc pass (by personality). Returns the composed brief — personality
  instructions + shared rules + the user's focus note + the reviewId to tag comments with.
- **`complete_review(project, reviewId, verdict)`** — close the pass.
- **`add_comment`** gains optional `reviewId`.
- **Prompts:** one MCP prompt per personality (`devils-advocate`, `fact-checker`, `trimmer`,
  `first-reader`, `architect`) so clients that surface prompts (e.g. `/mcp__elves__trimmer` in
  Claude Code) can summon a pass without the app UI at all.

## UI

A **Review** control in the topbar beside the project switcher (it's a project-level action,
not a card-creation tool, so it does not join the card toolbar). It opens a dropdown panel:

- **The cast**: five rows — name, one-line description — click to summon. An optional
  single-line **focus** field above them scopes the pass ("just the intro").
- **Passes**: current + recent passes newest-first. A `pending` pass shows a "waiting for your
  agent" hint (with the one-line instruction for how to pick it up from the agent side) and a
  cancel ×. An `in-progress` pass shows a working indicator in the agent's accent. A `done`
  pass shows the verdict, its open/total comment tally (computed live from the editor store),
  and a clear ×.
- New comment types get their own color ramps + `data-type` styling on the existing comment
  pills; the type label renders from the type string as today.

**Noise stance:** nothing is ambient. A pass runs only when summoned (from either surface),
budgets cap its output, resolved comments never resurface, and the verdict lives in the panel —
not as another thing stuck to the canvas.

## Out of scope (deliberate)

- Voice doc (seam noted in the Trimmer brief).
- Tagging question cards with a reviewId.
- Auto-running or scheduled reviews; any push channel to the agent. The request queue is pull —
  an agent finds it via `list_reviews` or the user invokes a prompt.
- Custom user-defined personalities (the model trivially extends; UI for authoring briefs is a
  later feature).
