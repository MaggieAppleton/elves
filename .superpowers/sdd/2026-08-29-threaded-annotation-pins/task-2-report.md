# Task 2 report: threaded annotation pin surface

Status: implemented; focused component and type checks passed.

## Changes

- Added `AnnotationThread`, reused by card and feedback pin popovers and the annotation rail.
- Replaced aggregate markers with one 28px, colour-tokened pin per unresolved card comment, positioned from `cardAnnotationPins` on the card's right edge.
- Made pins counter-scale with canvas zoom, expose their complete read-only thread on hover or focus, and retain the exact inspector target on click.
- Removed comment-row layout reservation (`commentH` is reset to zero) and applied the same pin treatment to open feedback.
- Kept the inspector's resolve/restore behaviour and feedback reviewer attribution.

## Verification

- `npx vitest run tests/components/AnnotationThread.test.ts tests/components/AnnotationRail.test.ts` — exit 0; 2 files and 2 tests passed.
- `npm run typecheck` — exit 0; `tsc --noEmit` completed without diagnostics.
- `npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts` — not a product assertion result: an isolated-port run stopped before canvas setup because the browser showed `No projects yet` after `resetProject`. Re-running with an explicit `ELVES_E2E_BASE` produced the same harness failure at the first `.tl-canvas` wait.

## Commit

- Implementation commit: `f6bee2c` (`feat(annotations): render threaded comment pins`).
- This final report is recorded in the follow-up documentation commit.

## Concerns

- Browser interaction coverage is present in `e2e/comments.spec.ts`, but it remains unexecuted past setup because of the existing isolated-port project bootstrap failure. The component tests and compiler checks are fresh and passing.
