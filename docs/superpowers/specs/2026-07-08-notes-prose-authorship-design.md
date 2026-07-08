# Notes, Prose & Authorship — Design Spec

Date: 2026-07-08
Status: Approved, in implementation

## Context

The `elves` app is a **tldraw v3 + React 18** canvas of "cards" (custom tldraw shapes).
Card content is a plain `text: string` edited in a raw `<textarea>` — no rich-text layer, no
edit history. Authorship today is a single field `authoredBy: string | null` (`null` = human,
an agent id like `'claude'` = agent), resolved to a display name/accent/logomark through the
`src/shapes/agents.tsx` registry. Prose cards are the user's protected draft: only prose
compiles into the linear document (`src/model/draft.ts`) and agents may not edit prose text
(`claudeMayEditCardText(kind) === kind !== 'prose'`).

Key files:
- `src/model/types.ts` — `CardProps`, `CardKind`, `NoteKind`.
- `src/model/cards.ts` — card factories, `claudeMayEditCardText`, type guards.
- `src/shapes/CardShapeUtil.tsx` — the one React component rendering note/prose/figure; tldraw
  schema mirror + migrations; the textarea `onChange` edit path.
- `src/shapes/agents.tsx` — agent registry, `agentInfo(id)`, logomarks.
- `src/apply/applyChangeSet.ts` + `server/applyChangeSet.ts` — agent edit path (`edit_card`).
- `src/theme.css` — `--elves-claude-accent`.

## Goals

1. **Note → Prose conversion.** Turn a note card into a prose card (joins the draft, becomes
   agent-protected).
2. **Multi-author marks.** When more than one author (e.g. an agent and the human, or two
   agents) contributed to a card, show all of them, not just the last writer.
3. **Word-level blame.** Track which author wrote which characters. On hover over the author
   icons, reveal agent-authored runs highlighted in the agent accent (orange); human runs stay
   plain.

## Core architecture — the attribution engine

Add one run-length-encoded field to `CardProps` (robust under insertion, no absolute offsets to
maintain):

```ts
// author is 'user' (the human) or an agent id such as 'claude'
export type AttributionRun = { author: string; length: number }
export type Attribution = AttributionRun[]   // runs concatenate to cover text exactly
// New field on CardProps:
attribution: Attribution | null   // null = legacy/untracked, treated as one run of authoredBy ?? 'user'
```

Shared pure util `src/model/attribution.ts` (used by BOTH client and server so behavior is
identical):

- `reattribute(oldText, newText, oldAttribution, author): Attribution`
  - Compute common prefix length `p` and common suffix length `s` (guard `p + s <= min(len)`).
  - Treat `[p, newLen - s)` as the inserted span, attributed to `author`.
  - Splice: keep runs covering `[0, p)`, insert one run `{author, length: (newLen - s) - p}`,
    keep runs covering `[oldLen - s, oldLen)`. Coalesce adjacent runs with the same author.
  - Single-region edit model — perfect for interactive typing and for agent whole-text
    replaces; a simultaneous paste + distant delete is approximated. Acceptable.
  - Invariant: `sum(run.length) === newText.length`. Add a normalizer that repairs/asserts this.
- `contributors(attribution): string[]` — distinct authors in order of first appearance.
- `normalizeAttribution(attribution, textLength)` — coalesce, drop zero-length runs, and if the
  total length disagrees with `textLength`, fall back to a single `'user'` run of `textLength`.

Migration (tldraw `cardVersions` in `CardShapeUtil.tsx` + any server-side migrate pass): existing
cards get `attribution = [{ author: authoredBy ?? 'user', length: text.length }]`. Down-migration
deletes the field.

**`authoredBy` is kept unchanged and additive** — existing gates (`delete_card` = agent owns it,
prose protection) keep reading `authoredBy`. Attribution never rewrites those semantics.

## Edit-path wiring

Both writers thread through `reattribute`:

- **Human — UI textarea `onChange`** (`CardShapeUtil.tsx`): today sets `authoredBy: null`. New:
  also set `attribution = reattribute(oldText, newValue, oldAttribution, 'user')`. Keep
  `authoredBy: null` so the card still counts as human-owned everywhere else.
- **Agent — `edit_card`** (`src/apply/applyChangeSet.ts` + `server/applyChangeSet.ts`): today
  writes only `text`/`figureTitle`. New: also set
  `attribution = reattribute(oldText, newText, oldAttribution, cs.author)`.
- **Creation**: `make*CardProps` seed `attribution = [{ author: authoredBy ?? 'user', length:
  text.length }]` (empty text → `[]` or `null`).

## Feature breakdown — three sequential PRs

### PR1 — Note → Prose conversion (independent, ships first)

- Add a user action (badge/context-menu item on a note card) "Convert to prose".
- Effect: `kind: 'prose'`, `noteKind: null`, `origin: null`. Card now compiles into the draft
  and agent text edits are blocked by the existing `claudeMayEditCardText` gate. Preserve id,
  position, text, comments, authorship.
- Only offered on note cards (`isNoteCard`); not on reference notes if their `text` is a user
  annotation — treat text notes as the primary target (confirm reference/image handling during
  implementation; simplest correct scope is text notes).
- No data-model change. Tests: unit test the prop transform; a component/e2e check that the
  action flips the badge and the card enters the draft.

### PR2 — Attribution engine + stacked author icons

- Implement `src/model/attribution.ts` (fully unit-tested: prefix/suffix diffing, run splicing,
  coalescing, the length invariant, legacy-null handling).
- Add the `attribution` field + validator + migration to the model and the tldraw schema mirror.
- Seed attribution in the factories; thread `reattribute` into both edit paths.
- Derive `contributors(attribution)` and render **all** contributors as overlapping/stacked
  marks in the badge row (and figure eyebrow). Design a small `UserGlyph` for the human, add a
  `'user'` entry path in `agents.tsx` (or a parallel resolver) so `'user'` resolves to a name +
  neutral color + glyph. Reuse existing accent tokens. `data-testid` on each mark.
- No highlighting yet.
- Tests: attribution unit suite is the backbone; component test asserting two marks render when
  attribution has two authors.

### PR3 — Blame highlight (view layer on PR2, branches off PR2)

- In **display** (non-editing) mode, render the card body by walking attribution runs: wrap
  agent-authored runs in `<span class="elves-blame-agent" style={{ color/bg: agent accent }}>`;
  human runs render plain.
- Reveal only while hovering the author-icon cluster (hover toggles a class on the card root;
  default hidden so normal reading is undisturbed). Respect `prefers-reduced-motion` for any
  transition.
- Edit mode (textarea) stays plain — textareas can't hold colored spans; blame is a reading
  affordance.
- Tests: given attribution with agent runs, hovering the icons adds the highlight class and the
  agent runs carry the blame span; human runs do not.

## Testing & tooling

- `npm run test` (vitest) for unit/component, `npm run typecheck`, `npm run e2e` (playwright)
  where a flow is involved. Each PR must pass typecheck + tests before opening.

## Non-goals

- Full git-style revision history / timeline.
- Rich text (bold/links) in card bodies.
- Multi-region diff precision beyond the single-span prefix/suffix model.
- Changing existing `authoredBy`-based gates.
