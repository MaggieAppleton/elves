# Canvas summaries & efficient reading — implementation plan

Spec: `docs/superpowers/specs/2026-07-03-canvas-summaries-and-efficient-reading-design.md`

Build in three stages; run `npm run typecheck` and `npm test` after each.

## Stage 1 — summary as data

1. **`src/model/types.ts`** — add `summary`, `summaryOfHash`, `summaryBy`, `summaryAt`
   (all `string | null`) to `CardProps`.
2. **`src/model/cards.ts`** — the three factories (`makeProseCardProps`,
   `makeSourceCardProps`, `makeImageSourceCardProps`, `makeReferenceCardProps`) set the
   four new fields to `null`.
3. **`src/model/summary.ts`** (new) — `SUMMARY_MIN_CHARS`, `summaryHash`,
   `isSummarizable`, `summaryState`, `mechanicalGist`, `cardGist`. Operate on a minimal
   `{ kind, sourceKind, text, summary, summaryOfHash }` shape.
4. **`src/model/changeset.ts`** — add `set_summary` to `Op`; validate in `isOp`;
   `changeSetWritesText` returns `false` (documented exception); `referencedCardIds`
   includes its `cardId`.
5. **`src/shapes/CardShapeUtil.tsx`** — add the four props to `CardShape` + `props`
   validator (`T.nullable(T.string)`); `AddSummary` migration (`up` sets the four to
   null, `down` deletes them); bump `cardVersions`.
6. **`src/apply/applyChangeSet.ts`** (client) & **`server/applyChangeSet.ts`** — handle
   `set_summary` (updateShape / mutate the four props).
7. **`server/summarize/summarizer.ts`** — `Summarizer` interface, `NoopSummarizer`,
   `summaryPrompt`.
8. **`server/summarize/ollama.ts`**, **`openai.ts`**, **`index.ts`
   (`summarizerFromEnv`)**.
9. **`server/summarize/reconcile.ts`** — `reconcileSummaries(cards, summarizer, now)`.
10. **`server/app.ts`** — `createServer(dataRoot, onChangeSet?, summarize?)`; per-project
    debounced scheduler invoked from `POST /canvas` and `POST /changeset`; factor the
    apply+persist+broadcast into a shared helper.
11. **`server/index.ts`** — build `summarizerFromEnv()`, pass to `createServer`, backfill
    each project once on startup.

Tests: `tests/model/summary.test.ts`, changeset additions, `tests/server/reconcile.test.ts`,
`tests/shapes/migration.test.ts` (AddSummary).

## Stage 2 — map-first reads

1. **`server/digest.ts`** — `CardDigest.summary`; `CardMapEntry`; `snapshotToCardMap`;
   `snapshotToCardsById`.
2. **`server/app.ts`** — `GET /projects/:id/map`, `POST /projects/:id/cards`; remove
   `GET /canvas-digest`.
3. **`mcp/elvesClient.ts`** — `readCardMap`, `readCards`; drop `readCanvasDigest`.
4. **`mcp/tools.ts`** — `readMapTool`, `readCardsTool`; drop `readCanvasTool`.
5. **`mcp/index.ts`** — register `read_map` + `read_cards` (compact JSON), remove
   `read_canvas`; update `create_source_card` description; keep `PROJECT` guidance.
6. **`skill/elves-canvas.md`**, **`README.md`** — `read_canvas` → `read_map`/`read_cards`.

Tests: update `tests/server/digest.test.ts` (+ map/cards), `tests/server/changeset.test.ts`
& `api.test.ts` (`/map`,`/cards`), replace `tests/mcp/tools.test.ts` readCanvas tests,
update `tests/mcp/server.test.ts`. Add an integration test: `FakeSummarizer` →
`createServer` → canvas save → `set_summary` broadcast.

## Stage 3 — zoom-out view

1. **`src/shapes/summaryView.ts`** (new) — `GIST_ZOOM`, `shouldShowGist(zoom, card)`.
2. **`src/shapes/CardShapeUtil.tsx`** — in `component()`, when `shouldShowGist`, render
   `cardGist(card)` in `.elves-card__text--gist`, skip editing branch.
3. **`src/shapes/card.css`** — `.elves-card__text--gist { color: var(--elves-claude-accent); }`.

Tests: `tests/shapes/summaryView.test.ts`.

## Verify

`npm run typecheck && npm test`. e2e (`npm run e2e`) needs a browser/dev server; run if
feasible, otherwise rely on unit coverage for the LOD logic (kept pure in
`summaryView.ts`). Ollama is optional at runtime; absence degrades gracefully.
