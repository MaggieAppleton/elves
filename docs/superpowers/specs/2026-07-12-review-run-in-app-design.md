# Run review passes in-app

**Date:** 2026-07-12
**Status:** Approved (design)

## Problem

Clicking a reviewer in the Review panel (e.g. "The Architect") does **not** run
a review. It writes a `pending` record to `reviews.json` and then waits, showing:

> "Waiting for an agent — ask yours to 'pick up my Elves review', or run the
> personality's prompt from its MCP client."

Users reasonably expect the click to *run* the review immediately — the way the
in-app agent chat (press `/`) spawns a headless `claude` and streams a response.
The two features are wired completely differently:

- **Chat** (`server/agentRun.ts`, `POST /agent/run`): the server spawns the CLI
  as a one-shot child, which drives the elves MCP tools against the canvas.
- **Review** (`src/client/reviews.ts` → `POST /projects/:id/reviews`): the server
  writes a `pending` record and waits for an *external* MCP agent to claim it via
  `start_review`.

Both paths ultimately drive the **same** MCP tools against the **same** canvas.
The only difference is *who launches the agent process*. This spec makes the
summon button launch the agent in-app, reusing the existing runner.

## Approach (chosen: "auto-pickup")

On summon, keep writing the `pending` review record exactly as today, then have
the server spawn a headless agent whose only job is to *claim and run that
review*. The spawned agent calls the same `start_review(reviewId)` →
`add_comment` → `complete_review` MCP tools an external agent would — so the
entire existing review state machine, comment tagging, live comment tally, and
WebSocket broadcasts work unchanged. The in-app agent is literally "an external
agent, but we launch it."

Rejected alternative (B, "server pre-claims"): the server transitions to
`in-progress` itself and hands the composed brief inline, bypassing
`start_review`. Rejected because it duplicates the claim logic across two paths
(MCP vs server) and the agent still needs the reviewId to tag comments and call
`complete_review`. Approach A treats the in-app runner as just another MCP
client, which is the whole reason the MCP layer exists.

## Decisions (locked with the user)

1. **Summon always launches in-app**, like chat.
2. **Parallel runs allowed** — a review run, other review runs, and a chat run
   can all be active at once. The runner is refactored from a single global run
   to a set of concurrent runs keyed by caller.
3. **Panel status only** — no transcript UI. The pass already shows
   `pending → in-progress → done` and a live comment tally over the WS; the
   comments *are* the deliverable. No SSE stream for reviews.
4. **Failed state + Retry** — when a review's in-app run dies (crash, CLI
   missing, cancel, or exits without completing), the pass lands in an explicit
   `failed` state showing the error, with a **Retry** action that re-spawns.

## Architecture changes

### 1. Runner: single-flight → keyed concurrent runs (`server/agentRun.ts`)

Replace the single `let active: ChildLike | null` with a `Map<string, ChildLike>`
keyed by a caller-supplied run key. New `AgentRunner` interface:

```ts
export interface AgentRunner {
  run(key: string, input: AgentRunInput, onEvent: (e: AgentEvent) => void): Promise<void>
  cancel(key: string): void
  isRunning(key: string): boolean
}
```

- `run(key, …)` refuses (emits an `error` event, resolves) if `key` is already
  running — so a given key is still single-flight, but different keys run in
  parallel.
- `cancel(key)` kills and forgets only that run.
- `isRunning(key)` reports one key.
- Run keys: chat uses the literal `'chat'`; a review run uses `review:<reviewId>`.

Everything else in the runner (adapter, `buildCommand`, stdout line-buffering,
terminal-event dedupe, `friendlySpawnError`) is unchanged.

### 2. Review model: add `failed` status + optional error (`src/model/reviews.ts`)

- `ReviewStatus = 'pending' | 'in-progress' | 'done' | 'dismissed' | 'failed'`.
- Add `error: string | null` to `Review` (the failure message shown in the
  panel; `null` otherwise). `makeReview` sets it `null`; `isReview` validates
  `strOrNull(r.error)`.
- `canTransition` gains `failed`:
  - `pending    → in-progress | dismissed | failed`
  - `in-progress → done | dismissed | failed`
  - `failed     → in-progress | dismissed`  (retry re-claims; × clears)
  - `done       → dismissed`
  - `dismissed  → (nothing)`

  `failed → in-progress` is what lets a **retry** work: the re-spawned agent
  calls `start_review(reviewId)`, whose claim path calls
  `transitionReview(status:'in-progress')`, now legal from `failed`.

### 3. Review store: carry `failed` + error (`server/reviews.ts`)

`transitionReview` accepts `status:'failed'` with an optional `error` message and
stamps `next.error`. Transitioning *away* from `failed` (retry) clears
`next.error = null`. No new disk format concerns — it's the same read-modify-write.

### 4. Launch helper + routes (`server/app.ts`)

Add an internal helper and one new route; reuse it from the summon-create path:

```ts
// Fire-and-forget: spawn an agent to claim and run review <reviewId>.
// No SSE — the panel tracks progress over the reviews WS broadcast.
async function launchReviewRun(projectId, reviewId): Promise<void>
```

`launchReviewRun` behaviour:
- If no `agent` runner is wired, or `agent.isRunning('review:'+reviewId)`, no-op
  (return). (Runner-absent = the review simply stays `pending`, claimable by an
  external agent — honest degradation; see §5 panel copy.)
- Build the review prompt (below) and `hasSelection:false`.
- `agent.run('review:'+reviewId, input, onEvent)` where `onEvent` captures the
  last `error` message.
- **After the run resolves** (child exited): re-read the review. If its status is
  still `pending` or `in-progress` (i.e. it never reached `done` and wasn't
  `dismissed`), transition it to `failed` with the captured error (or a generic
  "the review agent stopped before finishing"). Wrap in try/catch: a
  `ReviewError` 409 (lost the race to `done`/`dismissed`) is swallowed. Broadcast.

Where it's called:
- **Summon:** `POST /projects/:id/reviews`, after creating a *pending* review
  (no `agent` field in the body) and broadcasting, fire
  `void launchReviewRun(id, review.id)`. Ad-hoc chat passes (with `agent` field)
  are untouched.
- **Retry:** new `POST /projects/:id/reviews/:reviewId/run` — 202-returns after
  firing `void launchReviewRun(id, reviewId)`. Guarded: 404 unknown review; no-op
  if already running that key.

**Review prompt** (the `-p` argument; the brief itself comes from `start_review`):

> A review pass is waiting for you on this canvas, id `<reviewId>`. Call
> `start_review` with reviewId `<reviewId>`, follow the returned brief exactly,
> leave your comments tagged with that reviewId, and finish by calling
> `complete_review`. Do only this review — nothing else.

The existing `buildPreamble` (system prompt) is reused as-is; its read_map
steering is harmless because the brief drives the agent to `read_draft`/`read_map`
itself.

### 5. Dismiss must kill a running review (`server/app.ts`)

In `POST /projects/:id/reviews/:reviewId/status`, when transitioning to
`dismissed`, first call `agent?.cancel('review:'+reviewId)` (idempotent no-op if
not running). This kills the child before the record becomes `dismissed`, so the
`launchReviewRun` completion handler sees `dismissed` and does **not** re-mark it
`failed`.

### 6. Client (`src/client/reviews.ts`, `src/App.tsx`)

- `summonReview` is **unchanged** — server auto-launches on create.
- Add `retryReview(projectId, reviewId)` → `POST …/reviews/:reviewId/run`.
- `App.tsx`: pass an `onRetry` handler to `ReviewPanel`.

### 7. Panel (`src/components/ReviewPanel.tsx`, `reviewPanel.css`)

- Treat `pending` as **"Starting…"** (an in-app agent is booting), not "waiting".
  Show a subtle starting state on the pass row.
- Replace the `anyPending` hint. New copy only when the runner is genuinely
  unavailable is out of scope to detect precisely from the client; instead:
  drop the "ask your agent to pick up" hint by default. (A `pending` review that
  never advances because no runner is wired still shows "Starting…"; the external
  MCP pickup path still works underneath for power users. We accept this minor
  copy imprecision to keep the client simple — see Risks.)
- Add a **`failed`** pass row: red/'failed' dot, the `error` text, and a
  **Retry** button (`data-testid="review-retry-<personality>"`) calling
  `onRetry(r.id)`. The × still dismisses.
- `active` filter includes `failed` so failed passes stay visible until dismissed.

## Data flow (summon → done)

1. Click → `summonReview` → `POST /reviews` creates `pending`, broadcasts,
   fires `launchReviewRun`.
2. `launchReviewRun` spawns `claude -p "<review prompt>"` keyed `review:<id>`.
3. Child calls `start_review(reviewId)` → `pending → in-progress` (agent id
   stamped) → broadcast → panel shows "claude is reading…".
4. Child leaves `add_comment`s (tagged reviewId) → canvas WS → live tally.
5. Child calls `complete_review(verdict)` → `in-progress → done` → broadcast →
   panel shows verdict + tally.
6. Child exits 0; completion handler sees `done`, does nothing.

**Failure:** child crashes / CLI missing / exits without `complete_review` →
completion handler sees `pending`|`in-progress` → `failed` + error → panel shows
Retry. **Dismiss mid-run:** × → status route cancels `review:<id>` child →
`dismissed`; completion handler sees `dismissed`, does nothing.

## Error handling

- **CLI not installed** (`ENOENT`): `run` emits the existing friendly
  "`claude` is not installed…" error → captured → review `failed` with that text.
- **Runner not wired** (tests / unconfigured server): `launchReviewRun` no-ops;
  review stays `pending`. No crash.
- **Retry while running**: `isRunning('review:'+id)` → no-op.
- **Race dismiss vs failure**: dismiss cancels first and sets `dismissed`;
  the failure transition is guarded (only from pending/in-progress) and swallows
  the resulting 409.
- **Race complete vs failure**: if the child completed (`done`) then exited, the
  completion handler's guard skips `failed`.

## Testing

- `tests/server/agentRun.test.ts` — rewrite for the keyed API: two keys run
  concurrently; same key refuses; `cancel(key)` kills only that run; `isRunning`
  per key. Fake spawn (existing `SpawnFn` injection).
- `tests/server/reviews.test.ts` — `failed` transitions; `error` set/cleared;
  `failed → in-progress` (retry) legal; `dismissed`/`done` still terminal.
- `tests/model/reviews.test.ts` — `canTransition` failed matrix; `isReview`
  accepts a valid `error` and rejects a non-string one; `makeReview` defaults
  `error:null`.
- `tests/server/agentRoutes.test.ts` — chat run still single-flight under key
  `'chat'`; a review run does **not** 409 a chat run (parallel).
- New `tests/server/reviewRun.test.ts` — with a fake runner injected into
  `createServer`: summon fires a run; a run that errors marks the review
  `failed` with the message; a run that completes (fake calls the status route)
  leaves it `done`; dismiss mid-run cancels the child and stays `dismissed`;
  `POST …/run` retries a `failed` review; runner-absent leaves it `pending`.
- `tests/mcp/tools.test.ts` — `start_review` still claims from `pending`; add a
  case claiming from `failed` (retry path) succeeds.

Run: `npm test` (vitest). Manual smoke: `npm run dev`, summon a reviewer, watch
it go Starting → reading → done with comments on the canvas.

## Out of scope / YAGNI

- No transcript UI for reviews (decision 3).
- No queue / concurrency cap (decision 2 — parallel; see Risks).
- No change to personalities, briefs, or the MCP prompt/pickup mechanism (it
  keeps working for external agents).
- No new "run" affordance beyond summon + retry.

## Risks

- **Unbounded parallel `claude` children.** Firing many summons at once spawns
  many CLIs. Accepted per decision 2; a soft cap (env-configurable max concurrent
  review runs, refusing/​failing beyond it) is a possible follow-up, not v1.
- **Pending copy imprecision.** When the runner is genuinely unwired, a `pending`
  review shows "Starting…" though nothing will start. Minor; the failure only
  surfaces if a user runs a server with no CLI, which also breaks chat. Acceptable
  for v1.
```
