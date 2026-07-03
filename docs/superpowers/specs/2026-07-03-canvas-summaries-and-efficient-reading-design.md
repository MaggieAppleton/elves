# Canvas summaries & efficient reading — design

Date: 2026-07-03

## Problem

`read_canvas` returns the **entire** canvas digest — every card's full text, every
comment body, every reference blob — pretty-printed with `JSON.stringify(_, null, 2)`.
For the "my-first-essay" project (92 cards, 14 sections) that is ~45,000 characters
≈ **11,300 tokens per call**, of which only ~19,000 chars is actual card text; the
rest is structural (long tldraw ids, repeated keys, whitespace). Because
`read_canvas` is called before *every* comment / move / merge / enrich (Claude needs
current ids), the cost compounds across a session, and most of each read is text
Claude did not need for that action.

Separately, when the human zooms out over 92 cards there is no way to read the shape
of the piece at a glance — cards show either full text (illegible when small) or
nothing.

Both problems share one missing primitive: a short **gist** of each long card.

## Philosophy (the constraint that shapes everything)

Elves' ironclad rule — *Claude never writes or edits card text* — applies to **prose
cards** (the user's final-essay voice) and is unchanged here. The user has confirmed
that **summaries, like section headers and comments, are Claude/model-authored
artifacts**. So a summary is *a label about a card*, never the card's text. It lives
in its own field, never overwrites `text`, carries provenance, and renders in Claude's
accent colour where shown — exactly the pattern `Reference` (`fetchedBy`/`fetchedAt`)
and sections (`authoredBy`) already use.

This feature adds a Claude-authored `summary` field. It does **not** touch the
"never write card text" rule, and it does not add any ability to write note-card
text (explicitly out of scope — YAGNI).

## The three initiatives (one shared foundation)

All three consume one new piece of data, the card `summary`:

1. **B — summary as data** (foundation): a model-authored gist for long text cards,
   generated server-side, stored on the card, flowing to open browsers via the
   existing change-set broadcast.
2. **A — map-first navigation** (the token win): replace `read_canvas` with a cheap
   `read_map` (sections + per-card `{id, kind, position, gist, textLen}`, *no* full
   text) plus a `read_cards(ids)` drill-down for full text only when needed.
3. **C — zoom-out view** (the human payoff): below a zoom threshold, a summarized card
   renders its gist instead of full text.

## Data model

Add to `CardProps` (and the tldraw `CardShape` props + validator + migration):

```ts
summary: string | null        // model-authored gist; null when short or not yet generated
summaryOfHash: string | null  // stable hash of the text the summary was built from (staleness)
summaryBy: string | null      // provenance, e.g. 'ollama/llama3.2', 'openai/gpt-4o-mini'
summaryAt: string | null      // ISO timestamp of generation
```

`text` is never touched. All four default to `null`; a single tldraw migration
(`AddSummary`) backfills existing shapes with nulls.

**Which cards are summarized:** text-bearing cards only —
`kind === 'prose'` or (`kind === 'source' && sourceKind === 'text'`). Image cards
(no text) and reference cards (already carry `description`) are excluded.

**Threshold:** `SUMMARY_MIN_CHARS = 180`. At or under that a card *is* its own
summary — `summary` stays `null` and the map/zoom show the (short) text directly.

### `src/model/summary.ts` (pure, unit-tested)

- `summaryHash(text): string` — small stable non-cryptographic hash (FNV-1a → base36).
- `isSummarizable(card): boolean` — text-bearing and `text.length > SUMMARY_MIN_CHARS`.
- `summaryState(card): 'generate' | 'clear' | 'ok'`
  - `generate` — summarizable and (`summary === null` or `summaryOfHash !== summaryHash(text)`).
  - `clear` — not summarizable but `summary !== null` (text was shortened; drop stale gist).
  - `ok` — otherwise.
- `mechanicalGist(text, max = 120): string` — first sentence / word-boundary
  truncation. The fallback the map and zoom use when no model summary exists.
- `cardGist(card): string` — `summary ?? mechanicalGist(text)`.

## Summarizer (the one impure seam)

```ts
export interface Summarizer {
  // returns a one-phrase gist, or null on any failure (unreachable, disabled, error)
  summarize(text: string): Promise<string | null>
  readonly label: string  // provenance stamp, e.g. 'ollama/llama3.2'
}
```

Backends under `server/summarize/`:

- **`OllamaSummarizer`** (default) — `POST {OLLAMA_HOST}/api/generate` with
  `{model, prompt, stream:false, options:{temperature:0}}`; env `OLLAMA_HOST`
  (default `http://localhost:11434`), `OLLAMA_MODEL` (default `llama3.2`). Times out;
  returns `null` on any error so nothing breaks when Ollama is absent.
- **`OpenAISummarizer`** — cloud option, `gpt-4o-mini` via `OPENAI_API_KEY`. Same
  interface; selected by env. (Anthropic can be added identically; out of scope to
  implement now.)
- **`NoopSummarizer`** — always returns `null`. The fallback and the test/CI default.

`summarizerFromEnv()` picks a backend from `ELVES_SUMMARIZER` (`ollama` | `openai`
| `off`), defaulting to `ollama`.

**Prompt:** "Summarize this note in one short phrase (≤ 12 words). Reply with only the
phrase." temperature 0.

**Graceful degradation:** if the summarizer returns `null`, the card's `summary`
stays `null`; every consumer falls back to `mechanicalGist`. The feature is purely
additive — no model, no breakage.

## Reconciliation (generation flow)

User text edits persist via `POST /projects/:id/canvas` (full snapshot); Claude's
writes flow through change-sets + realtime broadcast. Summaries must reach open
browsers live, so **generation produces a change-set** through the existing pipeline.

New op: `set_summary`.

```ts
| { kind: 'set_summary'; cardId: string; summary: string | null;
    summaryOfHash: string | null; summaryBy: string | null; summaryAt: string | null }
```

- `isOp` validates it structurally.
- `changeSetWritesText` returns **false** for it (a machine label about the card, not
  the user's prose/card text — a conscious, documented exception like
  `edit_section_text`).
- `referencedCardIds` includes its `cardId` (it targets an existing card; the server's
  cross-project check applies).
- Server (`applyChangeSetToSnapshot`) and client (`src/apply/applyChangeSet`) both set
  the four summary props on the target card.

`server/summarize/reconcile.ts`:

```ts
reconcileSummaries(
  cards: CardDigest[],
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null>
```

Pure w.r.t. its deps (inject a `FakeSummarizer` + fixed `now` in tests). Computes
`generate`/`clear` sets via `summaryState`, calls the summarizer for `generate` cards,
emits `set_summary` ops (author `claude`), returns a change-set or `null` if nothing
to do (including when the summarizer returns `null` for every card).

**Wiring (`server/app.ts`):** `createServer(dataRoot, onChangeSet?, summarize?)`.
When `summarize` is provided (production only — tests/existing callers omit it, so the
feature is dormant and hermetic), a per-project debounced scheduler runs after
`POST /canvas` and after `POST /changeset`: read canvas → `reconcileSummaries` → if a
change-set comes back, apply + persist (reuse the changeset handler's apply/persist)
and `onChangeSet` broadcast. One reconcile per project at a time; a save during a run
re-marks the project dirty.

**Backfill:** `server/index.ts` reconciles each project once on startup (guarded by
`summaryOfHash`, so it only summarizes missing/stale cards — cheap after first run,
and a no-op when Ollama is down).

## Map-first reads

`server/digest.ts` gains:

- `CardDigest.summary: string | null` (full drill-down read includes the stored gist).
- `CardMapEntry` = `{ id, kind, sourceKind, x, y, gist, textLen, mergedInto?, refType? }`
  where `gist = cardGist(card)` (stored summary, else mechanical). `mergedInto`/`refType`
  are omitted when null to keep entries tiny. No full text, no comment bodies, no
  reference blob.
- `snapshotToCardMap(snapshot): { sections: SectionDigest[]; cards: CardMapEntry[] }`.
- `snapshotToCardsById(snapshot, ids, assetsDir?): CardDigest[]` — full digests for the
  requested ids.

Endpoints (`server/app.ts`), replacing `GET /canvas-digest`:

- `GET  /projects/:id/map` → `snapshotToCardMap`.
- `POST /projects/:id/cards` `{ ids: string[] }` → `snapshotToCardsById`.

(Express `res.json` is already compact; the pretty-print waste was only in the MCP
layer.)

## MCP layer

Retire `read_canvas`. Add two tools, both serialized with **compact** JSON
(`JSON.stringify(x)` — no `null, 2`):

- **`read_map(project)`** — the new "call this first" tool. Returns sections + the
  per-card map. Description explains: scan the map, then `read_cards` the few cards you
  need.
- **`read_cards(project, cardIds)`** — full text/comments/reference for the given ids.

`create_source_card`'s description and all skill/README references update
`read_canvas` → `read_map`/`read_cards`. `elvesClient` gains `readCardMap` / `readCards`
and drops `readCanvasDigest`.

Estimated effect on the essay: the map is ~3× smaller than today's read (~3–4k vs
11.3k tokens) and Claude pays for full text only on the handful of cards it opens.
The long tldraw ids remain the biggest map cost; they are **not** aliased (the write
tools need real ids — a deliberate tradeoff).

## Zoom-out view

`CardShapeUtil.component()` reads `this.editor.getZoomLevel()` (reactive). The
decision is a pure helper `shouldShowGist(zoom, card)` (unit-tested):
below `GIST_ZOOM = 0.5`, a text card with a non-empty `summary` renders `cardGist(card)`
in a `.elves-card__text--gist` class coloured `var(--elves-claude-accent)`, and skips
the editing branch. Short cards (no summary) render their normal short text. Image and
reference cards are unaffected. Autosize keeps measuring full text (the gist floats in
the card's full footprint — the box size itself signals "big card").

## Staging

1. **Stage 1** — model (`summary.ts`, `CardProps`, shape props + `AddSummary`
   migration, `set_summary` op + guards), summarizer + backends, `reconcile`, server
   wiring + backfill.
2. **Stage 2** — `snapshotToCardMap` / `snapshotToCardsById`, `/map` + `/cards`
   endpoints (remove `/canvas-digest`), MCP `read_map` / `read_cards`, retire
   `read_canvas`, compact JSON, skill/README updates.
3. **Stage 3** — `shouldShowGist` + zoom-out rendering + `.elves-card__text--gist` CSS.

## Testing

- `tests/model/summary.test.ts` — hash stability, `summaryState`, threshold,
  `mechanicalGist`, `cardGist`.
- `tests/model/changeset.test.ts` (add) — `set_summary` valid/invalid `isOp`,
  `changeSetWritesText(set_summary) === false`, `referencedCardIds` includes it.
- `tests/server/reconcile.test.ts` — `FakeSummarizer`: generates for long cards,
  clears shortened, skips short/current, returns `null` when the summarizer yields
  nothing.
- `tests/server/digest.test.ts` (update + add) — `summary` in `CardDigest`,
  `snapshotToCardMap`, `snapshotToCardsById`.
- `tests/server/api.test.ts` / `changeset.test.ts` (update) — `/map` + `/cards`
  replace `/canvas-digest`; one integration test that a `FakeSummarizer` passed to
  `createServer` broadcasts a `set_summary` change-set after a canvas save.
- `tests/mcp/tools.test.ts` (replace) — `readMapTool` + `readCardsTool`;
  `tests/mcp/server.test.ts` lists `read_map`/`read_cards`, not `read_canvas`.
- `tests/shapes/migration.test.ts` (add) — `AddSummary` up/down.
- `tests/shapes/summaryView.test.ts` — `shouldShowGist`.

`FakeSummarizer` keeps all tests offline and deterministic; the server default when no
summarizer is wired is fully dormant, so existing suites stay hermetic.

## Out of scope

- Claude authoring note-card *text* (only summaries here).
- Aliasing tldraw ids to shorter tokens.
- Anthropic summarizer backend (interface supports it; not implemented now).
- Summarizing reference cards (they already have `description`).
