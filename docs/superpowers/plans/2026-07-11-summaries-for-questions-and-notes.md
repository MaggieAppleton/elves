# Question-card summaries + Ollama retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give question cards Ollama one-phrase gists shown when zoomed out (like note/prose cards), and add a self-limiting retry so summaries left unfilled while Ollama was down get generated once it recovers.

**Architecture:** A question shape is agent-authored plain text with no card-kind to exclude — structurally identical to a comment — so the whole pure decision layer (`isCommentSummarizable`, `commentSummaryState`, `commentGist`) is reused. A new `set_question_summary` op carries the model gist through the existing apply + broadcast pipeline. Slice B threads a `pending` flag out of `reconcileCanvasFile` and adds a backoff re-run in the server's per-project scheduler.

**Tech Stack:** TypeScript, tldraw (custom `ShapeUtil` + prop migrations), Express server, Vitest (unit/integration), Playwright (e2e), Ollama (local summarizer, injected as a `Summarizer` in tests).

## Global Constraints

- **One-sentence house rule** does not apply here (that governs agent-authored marginalia copy, not code).
- **Summaries are additive, never load-bearing:** every path must degrade to a mechanical gist / no-op when Ollama is unreachable — never throw.
- **Agents never write the user's prose:** any new op that writes text must be added consciously to `changeSetWritesText`'s safe list; `set_question_summary` writes a machine gist into a question's own `summary` field only.
- **Reuse the comment pipeline** for questions; do NOT introduce a generic card/comment/question reconciler (rejected in the spec).
- **tldraw migrations:** a new shape prop requires a `createShapePropsMigrationSequence` step; mirror `cardVersions.AddSummary` exactly.
- Run the full check before opening the PR: `npm test` and `npm run build` (or the repo's lint/typecheck script) must pass.

---

## File map

**Slice A — question summaries + gist**
- Modify `src/model/questions.ts` — 4 summary fields on `QuestionProps` + `makeQuestionProps` defaults.
- Modify `src/shapes/QuestionShapeUtil.tsx` — shape props, `questionMigrations` + `addQuestionSummaryUp`, gist render branch.
- Modify `src/shapes/summaryView.ts` — `shouldShowQuestionGist` pure predicate.
- Modify `src/model/changeset.ts` — `set_question_summary` op (union, `isOp`, `changeSetWritesText`).
- Modify `src/apply/applyChangeSet.ts` — `applySetQuestionSummary` + switch case.
- Modify `server/digest.ts` — `snapshotToSummarizableQuestions`.
- Modify `server/summarize/reconcile.ts` — `reconcileQuestionSummaries` + `ReconcileQuestion`.
- Modify `server/summarize/index.ts` — export `reconcileQuestionSummaries`.
- Modify `server/summarize/runner.ts` — include questions in `reconcileCanvasFile`.
- Tests: `tests/shapes/migration.test.ts`, `tests/model/summaryView.test.ts`, `tests/apply/applyChangeSet.test.ts`, `tests/server/reconcile.test.ts`, `e2e/gist-overflow.spec.ts` (or a new `e2e/question-gist.spec.ts`).

**Slice B — retry on recovery**
- Modify `server/summarize/runner.ts` — `reconcileCanvasFile` returns `{ changeSet, pending }`.
- Modify `server/app.ts` — backoff retry beside the existing debounce maps.
- Tests: `tests/server/reconcile.test.ts` (pending flag), `tests/server/*` app-level retry test.

---

## Task 1: Question summary props + migration

**Files:**
- Modify: `src/model/questions.ts`
- Modify: `src/shapes/QuestionShapeUtil.tsx`
- Test: `tests/shapes/migration.test.ts`

**Interfaces:**
- Produces: `QuestionProps` now has `summary`, `summaryOfHash`, `summaryBy`, `summaryAt` (all `string | null`); `makeQuestionProps(text?, authoredBy?, dismissed?)` defaults them to `null`. Exports `addQuestionSummaryUp(props: Record<string, unknown>): void` and `questionMigrations` from `QuestionShapeUtil.tsx`.

- [ ] **Step 1: Write the failing migration test**

Add to `tests/shapes/migration.test.ts`:

```ts
import { addQuestionSummaryUp } from '../../src/shapes/QuestionShapeUtil'

test('AddSummary migration adds the four null summary fields to a pre-summary question', () => {
  const props: Record<string, unknown> = {
    w: 370, h: 96, text: 'a long question?', authoredBy: 'claude', dismissed: false,
  }
  addQuestionSummaryUp(props)
  expect(props).toMatchObject({
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shapes/migration.test.ts -t "pre-summary question"`
Expected: FAIL — `addQuestionSummaryUp` is not exported.

- [ ] **Step 3: Extend `QuestionProps` and `makeQuestionProps`**

In `src/model/questions.ts`, add to the `QuestionProps` interface (after `dismissed`):

```ts
  /** Model-authored one-phrase gist of the question, shown zoomed out in place
   * of the full text (see commentGist). Mirrors a card's summary fields exactly;
   * null when not yet generated. */
  summary: string | null
  /** Hash of the `text` this summary was built from, for staleness detection. */
  summaryOfHash: string | null
  /** Provenance of the summary, e.g. 'ollama/llama3.2'. */
  summaryBy: string | null
  /** ISO timestamp of when the summary was generated. */
  summaryAt: string | null
```

And update `makeQuestionProps`:

```ts
export function makeQuestionProps(
  text = '',
  authoredBy = 'claude',
  dismissed = false,
): QuestionProps {
  return {
    w: QUESTION_DEFAULT_W, h: QUESTION_DEFAULT_H, text, authoredBy, dismissed,
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
}
```

- [ ] **Step 4: Add props, migration, and `addQuestionSummaryUp` to the shape util**

In `src/shapes/QuestionShapeUtil.tsx`:

Update the imports at the top to add the migration helpers:

```ts
import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  stopEventPropagation, createShapePropsMigrationSequence, createShapePropsMigrationIds,
  type Editor, type Geometry2d,
} from 'tldraw'
```

Extend the `QuestionShape` props type:

```ts
export type QuestionShape = TLBaseShape<'question', {
  w: number
  h: number
  text: string
  authoredBy: string
  dismissed: boolean
  summary: string | null
  summaryOfHash: string | null
  summaryBy: string | null
  summaryAt: string | null
}>
```

Add the migration (place above the class, mirroring `cardMigrations`):

```ts
// Questions predate their summary fields; default them to "no summary yet" so
// reconciliation treats an old question exactly like a freshly-created one.
export function addQuestionSummaryUp(props: Record<string, unknown>): void {
  props.summary = null
  props.summaryOfHash = null
  props.summaryBy = null
  props.summaryAt = null
}

const questionVersions = createShapePropsMigrationIds('question', { AddSummary: 1 })

export const questionMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: questionVersions.AddSummary,
      up: (props) => addQuestionSummaryUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        delete p.summary
        delete p.summaryOfHash
        delete p.summaryBy
        delete p.summaryAt
      },
    },
  ],
})
```

Extend the runtime `props` record and register migrations inside the class:

```ts
  static override props: RecordProps<QuestionShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
    authoredBy: T.string,
    dismissed: T.boolean,
    summary: T.nullable(T.string),
    summaryOfHash: T.nullable(T.string),
    summaryBy: T.nullable(T.string),
    summaryAt: T.nullable(T.string),
  }

  static override migrations = questionMigrations
```

- [ ] **Step 5: Run the migration test to verify it passes**

Run: `npx vitest run tests/shapes/migration.test.ts -t "pre-summary question"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/questions.ts src/shapes/QuestionShapeUtil.tsx tests/shapes/migration.test.ts
git commit -m "feat(questions): add summary props + AddSummary migration"
```

---

## Task 2: `set_question_summary` change-set op

**Files:**
- Modify: `src/model/changeset.ts`
- Test: `tests/model/changeset.test.ts`

**Interfaces:**
- Produces: `Op` union member `{ kind: 'set_question_summary'; questionId: string; summary: string | null; summaryOfHash: string | null; summaryBy: string | null; summaryAt: string | null }`. `isOp` validates it; `changeSetWritesText` returns `false` for it.

- [ ] **Step 1: Write the failing validation test**

Add to `tests/model/changeset.test.ts` (match the file's existing import of `isOp`/`changeSetWritesText`; add them to the import if missing):

```ts
test('isOp accepts a well-formed set_question_summary and rejects a malformed one', () => {
  expect(isOp({
    kind: 'set_question_summary', questionId: 'q1',
    summary: 'a gist', summaryOfHash: 'abc', summaryBy: 'ollama/llama3.2', summaryAt: 'T',
  })).toBe(true)
  expect(isOp({
    kind: 'set_question_summary', questionId: 'q1',
    summary: 'a gist', summaryOfHash: 'abc', summaryBy: 'ollama/llama3.2', summaryAt: 5,
  })).toBe(false)
})

test('set_question_summary does not count as writing prose', () => {
  const cs = {
    id: 's1', author: 'claude',
    ops: [{ kind: 'set_question_summary', questionId: 'q1', summary: 'g', summaryOfHash: 'h', summaryBy: 'b', summaryAt: 'T' }],
  }
  expect(changeSetWritesText(cs as never)).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/changeset.test.ts -t set_question_summary`
Expected: FAIL — op is unrecognized (`isOp` returns false; `changeSetWritesText` hits the `default: true` branch).

- [ ] **Step 3: Add the op to the union, validation, and safe list**

In `src/model/changeset.ts`, add to the `Op` union (after the `set_comment_summary` member):

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

Add to `isOp`'s switch (after the `set_comment_summary` case):

```ts
    case 'set_question_summary':
      return typeof op.questionId === 'string' &&
        isStringOrNull(op.summary) && isStringOrNull(op.summaryOfHash) &&
        isStringOrNull(op.summaryBy) && isStringOrNull(op.summaryAt)
```

Add a doc paragraph near the other `set_*` exceptions and add the case to `changeSetWritesText`'s safe list (the block that `return false`s), after `case 'set_comment_summary':`:

```ts
      case 'set_question_summary':
```

Add this to the `changeSetWritesText` doc comment (after the `set_comment_summary` paragraph):

```
 * set_question_summary is the same exception, applied to a question shape: it
 * writes a model-authored gist *about a question* into that question's own
 * `summary` field, never the question's `text` (itself already a machine
 * annotation — the agent's question, not the user's prose). Same safety class
 * as set_summary. Scoped to this one op.
```

> Note: do NOT add `set_question_summary` to `referencedCardIds` — it references a question shape, not a card, and these ops are generated server-internally.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/changeset.test.ts -t set_question_summary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/changeset.ts tests/model/changeset.test.ts
git commit -m "feat(changeset): add set_question_summary op"
```

---

## Task 3: Apply `set_question_summary`

**Files:**
- Modify: `src/apply/applyChangeSet.ts`
- Test: `tests/apply/applyChangeSet.test.ts`

**Interfaces:**
- Consumes: the `set_question_summary` op from Task 2; `QuestionShape` from Task 1.
- Produces: `applySetQuestionSummary(editor, op)` updates the four summary fields on the addressed question shape; a no-op returning `[]` when the id is missing. Wired into `applyOp`'s switch.

- [ ] **Step 1: Write the failing apply test**

Add to `tests/apply/applyChangeSet.test.ts` (reuse the file's existing editor test harness — find how it builds an `editor` and creates shapes; mirror an existing `set_summary`/`create_question` test). Concretely:

```ts
test('set_question_summary writes the gist onto the question shape', () => {
  const editor = makeEditor() // however the file constructs its test editor
  applyChangeSet(editor, {
    id: 'c', author: 'claude',
    ops: [{ kind: 'create_question', text: 'a long question?', x: 0, y: 0 }],
  })
  const qId = editor.getCurrentPageShapes().find((s) => s.type === 'question')!.id
  applyChangeSet(editor, {
    id: 'c2', author: 'claude',
    ops: [{ kind: 'set_question_summary', questionId: qId, summary: 'gist', summaryOfHash: 'h', summaryBy: 'b', summaryAt: 'T' }],
  })
  const q = editor.getShape(qId) as any
  expect(q.props.summary).toBe('gist')
  expect(q.props.summaryOfHash).toBe('h')
})

test('set_question_summary is a no-op when the question is gone', () => {
  const editor = makeEditor()
  expect(() => applyChangeSet(editor, {
    id: 'c', author: 'claude',
    ops: [{ kind: 'set_question_summary', questionId: 'shape:missing', summary: 'g', summaryOfHash: 'h', summaryBy: 'b', summaryAt: 'T' }],
  })).not.toThrow()
})
```

> If the existing tests use a shared `beforeEach` editor rather than `makeEditor()`, follow that pattern instead — match the file, don't invent a helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/apply/applyChangeSet.test.ts -t set_question_summary`
Expected: FAIL — `applySetQuestionSummary` not implemented; the op falls through the switch.

- [ ] **Step 3: Implement `applySetQuestionSummary` and wire the switch**

In `src/apply/applyChangeSet.ts`, import `QuestionShape`:

```ts
import type { QuestionShape } from '../shapes/QuestionShapeUtil'
```

Add the function (beside `applySetCommentSummary`):

```ts
function applySetQuestionSummary(
  editor: Editor,
  op: Extract<Op, { kind: 'set_question_summary' }>,
): TLShapeId[] {
  const shape = editor.getShape(op.questionId as QuestionShape['id']) as QuestionShape | undefined
  if (!shape) return []
  editor.updateShape<QuestionShape>({
    id: shape.id, type: 'question',
    props: {
      summary: op.summary,
      summaryOfHash: op.summaryOfHash,
      summaryBy: op.summaryBy,
      summaryAt: op.summaryAt,
    },
  })
  return [shape.id]
}
```

Add the switch case in `applyOp` (after `set_comment_summary`):

```ts
    case 'set_question_summary':
      return applySetQuestionSummary(editor, op)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/apply/applyChangeSet.test.ts -t set_question_summary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apply/applyChangeSet.ts tests/apply/applyChangeSet.test.ts
git commit -m "feat(apply): apply set_question_summary to the question shape"
```

---

## Task 4: Server reconciliation for questions

**Files:**
- Modify: `server/digest.ts`
- Modify: `server/summarize/reconcile.ts`
- Modify: `server/summarize/index.ts`
- Modify: `server/summarize/runner.ts`
- Test: `tests/server/reconcile.test.ts`

**Interfaces:**
- Consumes: `SummarizableComment`, `commentSummaryState`, `summaryHash` from `src/model/summary.ts`; `set_question_summary` op.
- Produces: `snapshotToSummarizableQuestions(snapshot): Array<SummarizableComment & { questionId: string }>`; `ReconcileQuestion` (= `SummarizableComment & { questionId: string }`) and `reconcileQuestionSummaries(questions, summarizer, now): Promise<ChangeSet | null>` exported from `server/summarize/reconcile.ts` and re-exported from `server/summarize/index.ts`. `reconcileCanvasFile` folds question ops into its combined change-set.

- [ ] **Step 1: Write the failing reconcile test**

Add to `tests/server/reconcile.test.ts`:

```ts
import { reconcileQuestionSummaries, type ReconcileQuestion } from '../../server/summarize/reconcile'

function question(over: Partial<ReconcileQuestion> = {}): ReconcileQuestion {
  return { questionId: 'q1', text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('reconcile generates a set_question_summary for a question with no summary', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileQuestionSummaries([question()], fake, () => 'T')
  expect(fake.calls).toEqual([LONG])
  expect(cs?.ops).toEqual([
    { kind: 'set_question_summary', questionId: 'q1', summary: 'a gist', summaryOfHash: summaryHash(LONG), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile is a no-op for an up-to-date question', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileQuestionSummaries(
    [question({ summary: 'g', summaryOfHash: summaryHash(LONG) })], fake, () => 'T',
  )
  expect(fake.calls).toEqual([])
  expect(cs).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/reconcile.test.ts -t set_question_summary`
Expected: FAIL — `reconcileQuestionSummaries` not exported.

- [ ] **Step 3: Add `snapshotToSummarizableQuestions` to the digest**

In `server/digest.ts`, add (mirroring `snapshotToSummarizableComments`, reusing the `type === 'question'` filter shape from `snapshotToQuestions`):

```ts
/** Just the fields question-summary reconciliation reasons about, keyed by the
 * question's own shape id. A question is agent-authored plain text, so it is
 * summarizable exactly like a comment. */
export function snapshotToSummarizableQuestions(
  snapshot: CanvasSnapshot,
): Array<SummarizableComment & { questionId: string }> {
  const store = storeOf(snapshot)
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'question' && r.props)
    .map((r: any) => ({
      questionId: r.id,
      text: r.props.text ?? '',
      summary: r.props.summary ?? null,
      summaryOfHash: r.props.summaryOfHash ?? null,
    }))
}
```

- [ ] **Step 4: Add `reconcileQuestionSummaries`**

In `server/summarize/reconcile.ts`, add the type and function (mirroring `reconcileCommentSummaries`, using `commentSummaryState` since a question shares the comment decision):

```ts
/** A question as reconciliation sees it: the summary decision fields plus its
 * own shape id (a question is addressed directly, unlike a comment). */
export interface ReconcileQuestion extends SummarizableComment {
  questionId: string
}

export async function reconcileQuestionSummaries(
  questions: ReconcileQuestion[],
  summarizer: Summarizer,
  now: () => string,
): Promise<ChangeSet | null> {
  const ops: Op[] = []
  for (const q of questions) {
    const state = commentSummaryState(q)
    if (state === 'clear') {
      ops.push({
        kind: 'set_question_summary', questionId: q.questionId,
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      })
    } else if (state === 'generate') {
      const summary = await summarizer.summarize(q.text)
      if (summary) {
        ops.push({
          kind: 'set_question_summary', questionId: q.questionId,
          summary, summaryOfHash: summaryHash(q.text),
          summaryBy: summarizer.label, summaryAt: now(),
        })
      }
    }
  }
  if (!ops.length) return null
  return { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
}
```

- [ ] **Step 5: Re-export and wire into the runner**

In `server/summarize/index.ts` add:

```ts
export { reconcileQuestionSummaries } from './reconcile'
```

In `server/summarize/runner.ts`, import `snapshotToSummarizableQuestions` and `reconcileQuestionSummaries`, then extend `reconcileCanvasFile`'s body:

```ts
  const questionCs = await reconcileQuestionSummaries(
    snapshotToSummarizableQuestions(canvas), summarizer, now,
  )
  const ops = [
    ...(cardCs?.ops ?? []), ...(commentCs?.ops ?? []), ...(questionCs?.ops ?? []),
  ]
```

(Leave the rest of `reconcileCanvasFile` unchanged for now — Task 6 changes its return shape.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/server/reconcile.test.ts`
Expected: PASS (new question tests + existing ones).

- [ ] **Step 7: Commit**

```bash
git add server/digest.ts server/summarize/reconcile.ts server/summarize/index.ts server/summarize/runner.ts tests/server/reconcile.test.ts
git commit -m "feat(summarize): reconcile question summaries"
```

---

## Task 5: Render the question gist when zoomed out

**Files:**
- Modify: `src/shapes/summaryView.ts`
- Modify: `src/shapes/QuestionShapeUtil.tsx`
- Test: `tests/model/summaryView.test.ts` (or wherever `summaryView` is unit-tested — check `tests/shapes/summaryView.test.ts`), plus `e2e/question-gist.spec.ts`

**Interfaces:**
- Consumes: `GIST_ZOOM`, `gistFontSize` from `summaryView.ts`; `commentGist` from `src/model/summary.ts`; `fittedGistFontSize` from `src/shapes/autosize.ts`.
- Produces: `shouldShowQuestionGist(zoom, q: { summary: string | null; text?: string }): boolean`.

- [ ] **Step 1: Write the failing predicate test**

Find the existing summaryView test file (`tests/shapes/summaryView.test.ts`) and add:

```ts
import { shouldShowQuestionGist } from '../../src/shapes/summaryView'

test('shouldShowQuestionGist: only below GIST_ZOOM and only with content', () => {
  expect(shouldShowQuestionGist(1, { summary: 'g', text: 'q?' })).toBe(false) // zoomed in
  expect(shouldShowQuestionGist(0.5, { summary: 'g', text: 'q?' })).toBe(true) // summary
  expect(shouldShowQuestionGist(0.5, { summary: null, text: 'q?' })).toBe(true) // falls back to text
  expect(shouldShowQuestionGist(0.5, { summary: null, text: '   ' })).toBe(false) // empty
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shapes/summaryView.test.ts -t shouldShowQuestionGist`
Expected: FAIL — not exported.

- [ ] **Step 3: Add the predicate**

In `src/shapes/summaryView.ts`, add:

```ts
/**
 * Whether a question should render its gist instead of its full text right now.
 * Unlike a card there is no image/reference kind to exclude — a question is
 * always summarizable text — so this is simply "zoomed out past GIST_ZOOM and
 * has something to show".
 */
export function shouldShowQuestionGist(
  zoom: number,
  q: { summary: string | null; text?: string },
): boolean {
  if (zoom >= GIST_ZOOM) return false
  return !!q.summary || !!q.text?.trim()
}
```

- [ ] **Step 4: Render the gist in `QuestionShapeUtil`**

In `src/shapes/QuestionShapeUtil.tsx`, add imports:

```ts
import { commentGist } from '../model/summary'
import { shouldShowQuestionGist, gistFontSize } from './summaryView'
import { fittedGistFontSize } from './autosize'
```

In `component(shape)`, after reading `const { text, authoredBy } = shape.props`, compute the gist state (reading zoom reactively, as the card does):

```ts
    const zoom = this.editor.getZoomLevel()
    const showGist = shouldShowQuestionGist(zoom, shape.props)
```

Replace the text `div` render:

```tsx
            <div
              className="elves-question__text"
              data-testid="question-text"
              data-gist={showGist ? 'true' : undefined}
              style={
                showGist
                  ? {
                      fontSize: fittedGistFontSize(
                        this.editor,
                        commentGist(shape.props),
                        shape.props.w,
                        shape.props.h,
                        gistFontSize(zoom),
                      ),
                    }
                  : undefined
              }
            >
              {showGist ? commentGist(shape.props) : text}
            </div>
```

- [ ] **Step 5: Run the predicate test to verify it passes**

Run: `npx vitest run tests/shapes/summaryView.test.ts -t shouldShowQuestionGist`
Expected: PASS.

- [ ] **Step 6: Write an e2e that a zoomed-out question shows its gist**

Create `e2e/question-gist.spec.ts`, mirroring `e2e/gist-overflow.spec.ts` (reuse its helpers for booting the app, creating a project, and setting zoom). The test: seed a question with a `summary`, zoom below `GIST_ZOOM`, assert `[data-testid="question-text"][data-gist="true"]` shows the summary text and its computed `font-size` equals a card gist's at the same zoom.

> Read `e2e/gist-overflow.spec.ts` first and copy its exact setup/fixtures — do not invent a new harness. If seeding a question with a summary is awkward via the UI, seed it through the MCP/create endpoint the other e2e specs use, then apply a `set_question_summary` via the same change-set POST path they use.

- [ ] **Step 7: Run the e2e**

Run: `npx playwright test e2e/question-gist.spec.ts`
Expected: PASS. (If Playwright needs the dev server / custom port, follow the repo's e2e convention — note `ELVES_ALLOWED_ORIGINS` is required on non-default ports.)

- [ ] **Step 8: Commit**

```bash
git add src/shapes/summaryView.ts src/shapes/QuestionShapeUtil.tsx tests/shapes/summaryView.test.ts e2e/question-gist.spec.ts
git commit -m "feat(questions): show the Ollama gist when zoomed out"
```

---

## Task 6: `reconcileCanvasFile` reports pending work

**Files:**
- Modify: `server/summarize/runner.ts`
- Modify: `server/app.ts` (update the one caller)
- Test: `tests/server/reconcile.test.ts`

**Interfaces:**
- Produces: `reconcileCanvasFile(canvasPath, summarizer, now): Promise<{ changeSet: ChangeSet | null; pending: boolean }>`. `pending` is true when there were generate-state units the summarizer could not fill (i.e. it was unreachable): computed as `filledCount < generateCount`, where `generateCount` counts units in `generate` state before the run and `filledCount` counts emitted `set_*` ops carrying a non-null `summary`.

- [ ] **Step 1: Write the failing pending test**

Add to `tests/server/reconcile.test.ts` a test that drives `reconcileCanvasFile` against a temp canvas file (reuse the file's `createProject`/temp-dir setup) with a summarizer that returns `null` (unreachable), and assert `pending === true`; then a run with a working summarizer leaves `pending === false`. Concretely, using the existing temp-project helpers in the file:

```ts
import { reconcileCanvasFile } from '../../server/summarize/runner'

test('reconcileCanvasFile reports pending when the summarizer is unreachable', async () => {
  const { canvasPath } = await seedCanvasWithLongCard() // reuse/adapt the file's temp-project seed
  const down = new FakeSummarizer(() => null)
  const r1 = await reconcileCanvasFile(canvasPath, down, () => 'T')
  expect(r1.changeSet).toBeNull()
  expect(r1.pending).toBe(true)

  const up = new FakeSummarizer(() => 'a gist')
  const r2 = await reconcileCanvasFile(canvasPath, up, () => 'T')
  expect(r2.changeSet?.ops.length).toBeGreaterThan(0)
  expect(r2.pending).toBe(false)
})
```

> If the reconcile test file has no on-disk canvas seed helper yet, add a small one that writes a minimal canvas.json with one long text card (use the structure under `data/projects/*/canvas.json`: `{ document: { store: { ... } } }`). Keep it in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/reconcile.test.ts -t "reports pending"`
Expected: FAIL — `reconcileCanvasFile` returns a `ChangeSet | null`, not `{ changeSet, pending }`.

- [ ] **Step 3: Compute and return `pending`**

In `server/summarize/runner.ts`, import the decision helpers:

```ts
import { summaryState, commentSummaryState } from '../../src/model/summary'
```

Rewrite `reconcileCanvasFile` to count generate-state units and emitted fills, and return the new shape:

```ts
export async function reconcileCanvasFile(
  canvasPath: string,
  summarizer: Summarizer,
  now: () => string,
): Promise<{ changeSet: ChangeSet | null; pending: boolean }> {
  const canvas = await readCanvas(canvasPath)
  const cards = snapshotToSummarizableCards(canvas)
  const comments = snapshotToSummarizableComments(canvas)
  const questions = snapshotToSummarizableQuestions(canvas)

  const generateCount =
    cards.filter((c) => summaryState(c) === 'generate').length +
    comments.filter((c) => commentSummaryState(c) === 'generate').length +
    questions.filter((q) => commentSummaryState(q) === 'generate').length

  const cardCs = await reconcileSummaries(cards, summarizer, now)
  const commentCs = await reconcileCommentSummaries(comments, summarizer, now)
  const questionCs = await reconcileQuestionSummaries(questions, summarizer, now)
  const ops = [...(cardCs?.ops ?? []), ...(commentCs?.ops ?? []), ...(questionCs?.ops ?? [])]

  // A generate-state unit that got filled emits a set_* op with a non-null
  // summary. If fewer were filled than wanted, the summarizer was unreachable
  // for the rest — report pending so the scheduler retries once it recovers.
  const filledCount = ops.filter((o) => 'summary' in o && o.summary !== null).length
  const pending = filledCount < generateCount

  if (!ops.length) return { changeSet: null, pending }
  const cs: ChangeSet = { id: `sum-${crypto.randomUUID()}`, author: 'claude', ops }
  await withCanvasLock(canvasPath, (fresh) => applyChangeSetToSnapshot(fresh, cs))
  return { changeSet: cs, pending }
}
```

- [ ] **Step 4: Update the caller in `server/app.ts`**

In `runSummaries`, change:

```ts
        const cs = await reconcileCanvasFile(canvasPath, summarize.summarizer, now)
        if (cs) onChangeSet?.(projectId, cs)
```

to:

```ts
        const { changeSet } = await reconcileCanvasFile(canvasPath, summarize.summarizer, now)
        if (changeSet) onChangeSet?.(projectId, changeSet)
```

(The `pending` value is consumed in Task 7.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/summarize/runner.ts server/app.ts tests/server/reconcile.test.ts
git commit -m "feat(summarize): reconcileCanvasFile reports pending work"
```

---

## Task 7: Backoff retry when Ollama recovers

**Files:**
- Modify: `server/app.ts`
- Test: `tests/server/api.test.ts` (or the app-level test file that boots `createServer` with an injected summarizer — check `tests/server/reconcile.test.ts`, which already imports `createServer`)

**Interfaces:**
- Consumes: `pending` from `reconcileCanvasFile` (Task 6).
- Produces: per-project backoff re-run — when a run leaves `pending === true`, a timer re-invokes `runSummaries` after a growing delay (5s → 10s → 20s → 40s, capped 60s); a run with `pending === false` clears the project's backoff. Reuses the existing `running`/`dirty` single-flight guard. Injectable delays for tests via the existing `SummarizeConfig`.

- [ ] **Step 1: Write the failing retry test**

Add an app-level test that boots `createServer` with a summarizer that fails the first N calls then succeeds, a fast/injected backoff, and a fake or real short timer; assert the card/question ends up summarized without any save or restart, and that no further retry is scheduled once filled. Sketch:

```ts
test('a summary left pending is retried once the summarizer recovers', async () => {
  let up = false
  const flaky = new FakeSummarizer(() => (up ? 'a gist' : null))
  const app = createServer(dataRoot, noopBroadcast, {
    summarizer: flaky, now: () => 'T', debounceMs: 1, retryBaseMs: 5, retryMaxMs: 10,
  }, /* ...other args... */)
  // seed a project with a long card, trigger a save so runSummaries runs
  // ...assert summary is still null (summarizer down)...
  up = true
  // ...advance timers / await the backoff...
  // ...assert the card now has a summary...
})
```

> Match the exact `createServer` signature and the app-test harness already used in `tests/server/reconcile.test.ts` / `tests/server/api.test.ts`. Prefer real short timers (`retryBaseMs: 5`) with `await` over fake timers if the file doesn't already use fake timers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/reconcile.test.ts -t "retried once the summarizer recovers"`
Expected: FAIL — no retry scheduling exists; `retryBaseMs`/`retryMaxMs` are not on `SummarizeConfig`.

- [ ] **Step 3: Add retry config + scheduling to `server/app.ts`**

Extend `SummarizeConfig` (find its definition near line 108) with optional tunables:

```ts
  /** Backoff for retrying reconciles left pending by an unreachable summarizer. */
  retryBaseMs?: number
  retryMaxMs?: number
```

Near the scheduler state (`pendingTimers`/`running`/`dirty`), add:

```ts
  const retryBaseMs = summarize?.retryBaseMs ?? 5_000
  const retryMaxMs = summarize?.retryMaxMs ?? 60_000
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryDelay = new Map<string, number>()

  function scheduleRetry(projectId: string): void {
    if (retryTimers.has(projectId)) return // one pending retry per project
    const delay = Math.min(retryDelay.get(projectId) ?? retryBaseMs, retryMaxMs)
    retryDelay.set(projectId, Math.min(delay * 2, retryMaxMs))
    const timer = setTimeout(() => {
      retryTimers.delete(projectId)
      void runSummaries(projectId)
    }, delay)
    timer.unref?.()
    retryTimers.set(projectId, timer)
  }

  function clearRetry(projectId: string): void {
    const t = retryTimers.get(projectId)
    if (t) clearTimeout(t)
    retryTimers.delete(projectId)
    retryDelay.delete(projectId)
  }
```

In `runSummaries`, capture `pending` and drive the backoff (replacing the current reconcile call site):

```ts
      const canvasPath = canvasPathFor(dataRoot, projectId)
      if (canvasPath && (await getProject(dataRoot, projectId))) {
        const { changeSet, pending } = await reconcileCanvasFile(canvasPath, summarize.summarizer, now)
        if (changeSet) onChangeSet?.(projectId, changeSet)
        if (pending) scheduleRetry(projectId)
        else clearRetry(projectId)
      }
```

(Remove the now-duplicated `const { changeSet } = ...` line from Task 6 — this replaces it.)

- [ ] **Step 4: Run the retry test to verify it passes**

Run: `npx vitest run tests/server/reconcile.test.ts -t "retried once the summarizer recovers"`
Expected: PASS.

- [ ] **Step 5: Run the full suite + build**

Run: `npm test`
Expected: PASS (all unit/integration).
Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/app.ts tests/server/reconcile.test.ts
git commit -m "feat(summarize): retry reconcile with backoff when Ollama recovers"
```

---

## Task 8: Verify end-to-end and open the PR

**Files:** none (verification + PR).

- [ ] **Step 1: Full check**

Run: `npm test && npm run build`
Expected: all green.

- [ ] **Step 2: Manual smoke (if Ollama available)**

Boot the app, create a question card with a long text, wait for the debounce, zoom out below 60%, confirm the question collapses to a one-line gist at the same font size as neighboring cards. With Ollama stopped, confirm the question still shows a mechanical gist and nothing throws; restart Ollama and confirm the retry fills the summary without an edit.

- [ ] **Step 3: Push and open a draft PR**

```bash
git push -u origin worktree-card-summaries-all
gh pr create --draft --title "feat: Ollama summaries for question cards + retry on recovery" --body "$(cat <<'EOF'
## Summary
- Question cards now get an Ollama one-phrase gist, shown when zoomed out past GIST_ZOOM, exactly like note/prose cards (reusing the comment summary pipeline).
- Added a self-limiting backoff retry so summaries left unfilled while Ollama was unreachable get generated once it recovers — closing the gap the startup backfill didn't cover.

Spec: docs/superpowers/specs/2026-07-11-summaries-for-questions-and-notes-design.md
Plan: docs/superpowers/plans/2026-07-11-summaries-for-questions-and-notes.md

## Test plan
- Unit: question migration round-trip, set_question_summary validation + apply, question reconcile, shouldShowQuestionGist, reconcileCanvasFile pending flag, backoff retry.
- e2e: a zoomed-out question shows its gist.
- Manual: verified gist render + Ollama-off degradation + retry-on-recovery.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review (done at authoring)

- **Spec coverage:** Slice A (question summary field, migration, op, apply, reconcile, render) → Tasks 1–5; Slice B (pending signal, backoff retry) → Tasks 6–7; testing + PR → Task 8. All spec sections mapped.
- **Type consistency:** `set_question_summary` shape (field `questionId`, four nullable strings) is identical across changeset union (T2), apply (T3), and reconcile (T4). `reconcileCanvasFile` return `{ changeSet, pending }` defined in T6 and consumed in T7. `shouldShowQuestionGist` signature matches between T5 def and use.
- **Placeholders:** e2e (T5.6) and the app-retry harness (T7.1) intentionally defer to the existing test fixtures rather than inventing new ones — the instruction is to copy the concrete neighboring spec's setup; every code-bearing step shows real code.
