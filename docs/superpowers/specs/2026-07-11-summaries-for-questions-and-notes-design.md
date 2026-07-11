# Zoom Ollama summaries for question cards + reliable note backfill

**Date:** 2026-07-11
**Status:** Approved (design)

## Problem

When the canvas is zoomed out past `GIST_ZOOM` (0.6), text-bearing cards swap
their full text for a one-line gist so the whole piece reads at a glance. That
gist is an Ollama-generated summary when available, falling back to a mechanical
truncation. Today this covers note (text) and prose cards and their comments.

Two things are missing:

1. **Question cards** (`shape:question`) are a separate tldraw shape with **no
   summary machinery at all** — no `summary`/`summaryOfHash`/`summaryBy`/
   `summaryAt` props, no reconciliation entry, no gist render. Zoomed out, a
   question keeps showing its full text while every card beside it collapses to
   a tidy gist, so it reads as visual noise.

2. **Summaries created while Ollama was unreachable are never retried
   mid-session.** The pure decision logic already regenerates any `null`
   summary, and a startup backfill (`backfillSummaries`, `server/index.ts`)
   sweeps every project on boot. But if Ollama is down at boot and comes back
   **without** a server restart or a canvas save, those cards stay `null`
   forever and only ever show the mechanical fallback.

Verified against saved data before writing this: in `augment-essay` 79/79
freestanding text/prose cards already carry Ollama summaries (grouped: 1/1),
same in the other projects — so freestanding *text* notes summarize correctly
today. The real note-card gap is retry-on-recovery, not a missing pipeline.

## Goals

- A question card gets an Ollama one-phrase gist, shown when zoomed out below
  `GIST_ZOOM`, exactly as note/prose cards do — same counter-scaled font, same
  staleness/provenance model, same silent degradation when Ollama is off.
- Any card/comment/question left un-summarized because Ollama was unreachable
  gets filled once Ollama becomes reachable again, without needing a restart or
  a save.

## Non-goals

- Reference and image note cards stay excluded from gists — they keep their own
  faces by design (a reference already carries a description).
- Figure cards keep title-as-gist; unchanged.
- No change to the summarizer prompt, model, or the mechanical fallback.
- No generalizing refactor of the card/comment summary paths (see Approach 2
  below, rejected).

## Design

Two slices, shipped in **one spec and one PR** (per approval). Both are additive
and degrade to no-ops when Ollama is off.

### Slice A — Question summaries + zoom gist

A question is agent-authored plain text with no card-kind to exclude — exactly
the shape of a **comment**. So the whole pure decision layer is reused:
`isCommentSummarizable`, `commentSummaryState`, `commentGist` (all in
`src/model/summary.ts`) apply to a question with zero new logic. Only the
addressing differs (a question is addressed by its own shape id, where a comment
needs `cardId` + `commentId`), which is why a new op is warranted.

**Chosen approach: a parallel `set_question_summary` op mirroring the comment
pipeline.** Alternatives considered:

- *Approach 2 — one generic reconciler for card/comment/question.* Rejected:
  a bigger refactor of working code, and the three units address differently
  (card by id, comment by card+comment id, question by id), so the abstraction
  fights the data.
- *Approach 3 — overload `set_summary`'s `cardId` to also accept a question
  id.* Rejected: muddies a clean op and its machine-annotation safety
  exception, and forces apply to branch on shape type.

**Changes:**

1. **`src/model/questions.ts`** — add the four summary fields to `QuestionProps`
   (`summary: string | null`, `summaryOfHash: string | null`,
   `summaryBy: string | null`, `summaryAt: string | null`), defaulted `null` in
   `makeQuestionProps`. Doc them as mirroring a card's summary fields.

2. **`src/shapes/QuestionShapeUtil.tsx`**
   - Extend `QuestionShape` props type + the runtime `props` record with the
     four fields (`T.nullable(T.string)`).
   - Add a `questionMigrations` sequence via `createShapePropsMigrationSequence`
     with a single `AddSummary` step (up: default the four fields to `null`;
     down: delete them) and register `static override migrations`. Questions
     have no migrations today, so this is the shape's first sequence.
   - Render a gist when zoomed out: read `editor.getZoomLevel()` (reactive) and,
     below `GIST_ZOOM`, replace the question text with `commentGist({text,
     summary, summaryOfHash})` sized by `gistFontSize(zoom)`, mirroring the gist
     branch in `CardShapeUtil`. The `?` glyph, agent mark, and dismiss control
     stay. A question is always summarizable text, so the show-gist predicate is
     simply `zoom < GIST_ZOOM && (summary || text.trim())` — no need to route
     through `shouldShowGist`, which carries card-only image/reference excludes.

3. **`src/model/changeset.ts`** — add to the `Op` union:

   ```ts
   | {
       kind: 'set_question_summary'
       questionId: string
       summary: string | null
       summaryOfHash: string | null
       summaryBy: string | null
       summaryAt: string | null
     }
   ```

   Add its structural validation alongside `set_summary`/`set_comment_summary`,
   and add it to the machine-annotation safe list (the same exception class:
   a model-authored label, never the user's prose).

4. **`src/apply/applyChangeSet.ts`** — `applySetQuestionSummary(editor, op)`:
   look up the question shape by `op.questionId`, `updateShape` the four fields;
   no-op if the shape is gone. Wire into the op switch.

5. **`server/digest.ts`** — `snapshotToSummarizableQuestions(snapshot)`
   returning `Array<SummarizableComment & { questionId: string }>` (a question's
   `text`/`summary`/`summaryOfHash` are the comment-summarizable shape), built
   from the existing `type === 'question'` filter used by `snapshotToQuestions`.

6. **`server/summarize/reconcile.ts`** — `reconcileQuestionSummaries(questions,
   summarizer, now)`: identical generate/clear loop to
   `reconcileCommentSummaries`, emitting `set_question_summary` ops keyed by
   `questionId`, using `commentSummaryState` for the decision.

7. **`server/summarize/runner.ts`** — call `reconcileQuestionSummaries` in
   `reconcileCanvasFile` and fold its ops into the combined change-set.

8. **`server/summarize/index.ts`** — export the new reconcile fn if the barrel
   pattern calls for it.

### Slice B — Retry when Ollama recovers mid-session

The reconcile decision logic already returns `generate` for any `null`/stale
summary; the only missing piece is a **trigger** after Ollama transitions
unreachable → reachable without a save or restart.

**Chosen approach: a self-limiting backoff retry while work remains.** After a
reconcile run, if the canvas still holds generate-state units (i.e. Ollama
produced nothing for them — it was unreachable), schedule a capped backoff
re-run for that project; the retry stops the moment a run leaves nothing
pending. Alternatives:

- *Reconcile on project-open (client connect).* Rejected as the sole fix:
  misses projects nobody reopens.
- *Fixed-interval polling sweep.* Rejected: runs forever even when everything
  is summarized.

The summarizer returns `null` for both "unreachable" and "nothing to do", so we
detect "pending remained" structurally rather than from the summarizer:
`reconcileCanvasFile` reports whether, after applying its ops, any
card/comment/question is still in `generate` state. (Equivalently: there were
generate-state units and zero ops came back — that only happens when the
summarizer yielded null for all of them, i.e. it was down.)

**Changes (all in `server/`):**

1. **`server/summarize/runner.ts`** — have `reconcileCanvasFile` return, besides
   the change-set, a `pending: boolean` (generate-state units remained after the
   run). Keep the existing return shape backward-compatible (e.g. return
   `{ changeSet, pending }` and update the one caller).

2. **`server/app.ts`** — beside the existing debounce `pendingTimers`/`running`/
   `dirty` maps, add a per-project backoff retry: when `runSummaries` sees
   `pending`, schedule a re-run with exponential backoff (e.g. 5s → 10s → 20s,
   cap ~60s); a run with `pending === false` clears the project's backoff.
   Reuse the existing single-flight guard so a retry never races a debounced
   reconcile. Timers `.unref()` so they never hold the process open.

## Data flow (unchanged pipeline, one new lane)

```
save / startup backfill / NEW backoff-retry
        │
        ▼
reconcileCanvasFile ── reconcileSummaries (cards) ──────┐
        │           ── reconcileCommentSummaries ───────┤─► ChangeSet (set_* ops)
        │           ── reconcileQuestionSummaries (NEW) ─┘
        ▼
withCanvasLock → applyChangeSetToSnapshot → persist → broadcast → open browsers
        │
        └─► pending? → schedule backoff retry (NEW)
```

Client: `set_question_summary` flows through the same apply path; the question
shape re-renders and, when zoomed out, shows its fresh gist.

## Testing

- **Model** (`tests/model/summary.test.ts`): questions reuse comment logic;
  add a focused case asserting a question routes through
  `commentSummaryState`/`commentGist` as expected (guards against future drift).
- **Apply** (`tests/apply/applyChangeSet.test.ts`): `set_question_summary` sets
  the four fields; no-op when the question id is missing; validation accepts the
  new op and rejects malformed variants.
- **Reconcile** (`tests/server/reconcile.test.ts`): a canvas with a long
  question yields a `set_question_summary`; a stale question regenerates; a
  down summarizer yields no op **and** reports `pending: true`; a fully
  summarized canvas reports `pending: false`.
- **Retry** (`tests/server/*`): with an injected summarizer that fails then
  succeeds, a single run leaves `pending`, and the scheduled retry fills it;
  once filled, no further retry is scheduled. Use the existing `now`/injected-
  summarizer test seams; no real Ollama.
- **Migration** (`tests/shapes/migration.test.ts`): a pre-summary question shape
  migrates up to the four `null` fields and round-trips down.
- **e2e** (`e2e/`): zoom a canvas below `GIST_ZOOM` and assert a question shows
  its gist line at the shared gist font size (mirror `e2e/gist-overflow.spec.ts`).

## Risks / notes

- **tldraw migration correctness** is the sharpest edge — a wrong `AddSummary`
  step corrupts existing question shapes. Mirror `cardVersions.AddSummary`
  exactly and cover with a round-trip migration test.
- Backoff must be **strictly self-limiting**: a bug that keeps `pending` true
  forever would busy-loop reconciles. The `pending === false` clear and the
  single-flight guard are the safeguards; the retry test asserts termination.
- Everything degrades to today's behavior when Ollama is off: questions show the
  mechanical `commentGist` fallback, and the retry simply keeps trying quietly.
