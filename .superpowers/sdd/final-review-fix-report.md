# Final Review Fix Report: Project Mutation Lock

## Status and commit

- Durable fix commit: `3854290c49311c686c124988219722f6d6fb4f90`
- Starting commit: `89a8826638d8203c2df9eaf7d2659ee299f1c730`
- Production lock semantics were preserved. Production edits are documentation-only.

## Finding coverage

### Important 1: rename-first HTTP production-boundary race

- `tests/server/api.test.ts`
  - Added a forwarding Vitest wrapper around the real project and multi-project lock functions. Each entry is recorded only after the real helper has enqueued.
  - Added deterministic rename-first HTTP canvas coverage: rename is queued ahead of the old-id save, rename returns 200, save returns 404, the old directory stays absent, and the renamed canvas stays untouched.
  - Added equivalent rename-first 404/no-orphan cases for asset upload and review creation.

### Important 2: timing-dependent and incomplete primitive tests

- `tests/server/api.test.ts`
  - Removed `observeSettlement`, event-loop turns, and the 50 ms I/O probe in favor of real-lock queue-entry signals.
- `tests/server/projects.test.ts`
  - Replaced the 100 ms rename probe with a forwarding `withProjectLocks` entry signal.
- `tests/server/migrate.test.ts`
  - Replaced the 100 ms namespace probe with a forwarding `withProjectNamespaceLock` entry signal.
- `tests/server/projectLock.test.ts`
  - Starts both opposite-order multi-lock calls synchronously before awaiting callback entry.
  - Added namespace failure cleanup coverage.
  - Added multi-project failure cleanup coverage proving both acquired project locks remain usable.

### Important 3: deterministic acceptance cases

- `tests/server/api.test.ts`
  - Canvas, asset, and review mutations queued before rename complete first and move with the project.
  - Canvas, asset, and review mutations queued after rename return 404 and never recreate the old directory.
- `tests/server/projects.test.ts`
  - Two concurrent renames targeting `report` queue under the namespace lock and deterministically allocate `report` and `report-2`.
- `tests/server/migrateNotes.test.ts`
  - Migration queued before rename transforms the canvas before it moves.
  - Migration queued after rename skips the stale id without recreating it; a subsequent normal pass discovers and transforms the renamed project.
  - Existing lock wrapper was corrected to record only after the real lock helper is invoked.

### Minor documentation

- `server/projectLock.ts`
  - Documents that the registry is process-local and does not coordinate multiple servers, Syncthing, or manual filesystem writers.
- `server/projects.ts`, `server/store.ts`
  - Removed stale claims that HTTP app callers pass `projectAliveGuard`; comments now describe locked path resolution and the guard's direct-caller compatibility role.

## Mutation RED evidence

Temporary mutations were applied with `apply_patch`, tested, and restored before the durable commit.

1. Removed canonical `.sort()` from `withProjectLocks`.
   - Command: `npm test -- tests/server/projectLock.test.ts -t "opposite project-id orders cannot deadlock"`
   - RED: 1 failed, 7 skipped; the target test timed out after 5000 ms because opposite acquisition orders formed a cycle.
2. Moved HTTP mutation work before the project lock while retaining a trailing observable lock call.
   - Command: `npm test -- tests/server/api.test.ts -t "rename queued before an HTTP canvas save makes the old-id writer 404 without an orphan"`
   - RED: 1 failed, 34 skipped; old-id save returned 200 instead of the required 404.

`git diff -- server/app.ts` was empty after restoration, and the committed `server/projectLock.ts` retains canonical sorting.

## GREEN verification

- Focused: `npm test -- tests/server/projectLock.test.ts tests/server/projects.test.ts tests/server/migrate.test.ts tests/server/api.test.ts tests/server/migrateNotes.test.ts`
  - 5 files passed; 75 tests passed.
- Full: `npm test`
  - 54 files passed; 736 tests passed.
- Types: `npm run typecheck`
  - Exit 0; no diagnostics.
- Build: `npm run build`
  - Exit 0; 5688 modules transformed; existing Vite large-chunk advisory only.
- Diff hygiene: `git diff --check`
  - Exit 0; no whitespace errors.

## Self-review

- Queue probes forward to real lock helpers and record only after invocation, so tests observe actual queue entry rather than replacing serialization.
- No production test hooks were added.
- Both queue orders are exercised for HTTP writers and note migration.
- Every old-id HTTP writer case asserts the old directory remains absent.
- Temporary mutation changes were fully restored before commit.
- One intermediate five-file focused run produced two unrelated API status mismatches; the API suite passed in isolation immediately afterward, the repeated five-file run passed, and the final full run passed. No reproducible change-specific failure remained.

## Concerns

- The build continues to emit the pre-existing Vite warning for a JavaScript chunk over 500 kB.
- The single non-reproducing intermediate API run is recorded above for traceability.
