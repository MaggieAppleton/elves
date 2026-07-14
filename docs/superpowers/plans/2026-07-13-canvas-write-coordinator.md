# Canvas Write Coordinator Implementation Plan

**Goal:** Replace every post-mount canvas reader and writer with one restartable,
revision-aware coordinator without changing the approved server or merge contracts.

**Stack:** React, TypeScript, tldraw, Vitest, Playwright.

## Task 1: Typed versioned transport

Files:

- Modify `src/client/persistence.ts`
- Modify `tests/client/persistence.test.ts`

Write failing tests for the protocol-v2 query, revision header, success revision,
and typed stale-revision error. Add `loadCanvasVersioned` and
`saveCanvasVersioned`; keep legacy functions only until the App cutover lands.

Verify: `npm test -- --run tests/client/persistence.test.ts`

## Task 2: Document adapter

Files:

- Create `src/client/canvasDocumentAdapter.ts`
- Create `tests/client/canvasDocumentAdapter.test.ts`

Write failing tests proving that normalization migrates incoming document
snapshots, diff application changes only document records, uses
`mergeRemoteChanges`, and preserves local session state. Add helpers to capture,
normalize, diff, and apply document state.

Verify: focused adapter tests and typecheck.

## Task 3: Serialized coordinator pump

Files:

- Create `src/client/canvasWriteCoordinator.ts`
- Create `tests/client/canvasWriteCoordinator.test.ts`

Build against fake transport/editor ports. Test first:

- edit during held save causes a fresh second save;
- `409 -> GET -> merge -> retry` preserves both sides;
- live local state is recaptured after the conflict fetch;
- a second conflict, fetch failure, and thrown job reject barriers without
  wedging later requests;
- sync requests coalesce and defer while a shape is being edited;
- disposed or rebound lifecycles cannot apply stale continuations.

The pump retains dirty work on every failure and publishes status transitions
without involving React effects.

Verify: focused coordinator tests and mutation checks for busy cleanup and live
local recapture.

## Task 4: Initialization, pending tokens, and lifecycle barriers

Files:

- Modify `src/client/canvasWriteCoordinator.ts`
- Modify `tests/client/canvasWriteCoordinator.test.ts`

Test read-only initialization, exact pending materialization stamps, conflict
reload/retry, initialization failure, switch flush behavior, and exclusive
rename/rebind. Edits made during rename must drain under the new identity; a
failed rename must resume saving under the old identity. Pending application
must pass `changeSetTokenStamp(token)` into the existing stamped change-set
applier, with focused metadata coverage.

Verify: focused coordinator tests.

## Task 5: Atomic App cutover and accessible status

Files:

- Modify `src/App.tsx`
- Modify related CSS and App tests only as needed

Remove all App-owned versioned reads/writes, resync buffers, and autosave pumps.
Mount one coordinator per editor/project; route store changes, realtime,
reconnect, switch, and rename through it. Keep effects limited to external
subscriptions with symmetric cleanup. Expose distinct loading, saving, unsaved,
conflict, and offline/error states in the existing status control.

Verify with static searches that `App.tsx` has no direct canvas transport call,
then run focused App tests and typecheck.

## Task 6: Browser races and publication gate

Files:

- Add focused Playwright coverage under `tests/e2e/`

Cover held save during typing, reconnect while editing, project switch, rename,
pending materialization, no autosave echo after remote apply, and hard conflict
preservation. Run focused tests, the complete unit suite, typecheck, production
build, and relevant Playwright tests. Request independent review, fix every
finding, rerun the complete gate, push, and open a PR stacked on the merge-kernel
branch.
