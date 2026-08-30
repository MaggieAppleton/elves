# Task 1 report: annotation pin contract

Status: complete

## Changes

- Added pure `annotationPin` tokens for all `CommentType | null` values.
- Added deterministic `cardAnnotationPins` placement with `PIN_SIZE = 28`, `PIN_GAP = 8`, and 36px row spacing.
- Added focused model tests, including empty cards and duplicate IDs preserving source order.

## Verification

- `npx vitest run tests/model/annotationPins.test.ts` — exit 0; 1 file passed, 4 tests passed.
- `npm run typecheck` — exit 0; `tsc --noEmit` completed without diagnostics.

## Commit

- Commit hash: `22c0d60c2585f9390fbd604e80a0d401085813b7` (amended once to include this final report hash).

## Files

- `src/model/annotationPins.ts`
- `tests/model/annotationPins.test.ts`
- `.superpowers/sdd/2026-08-29-threaded-annotation-pins/task-1-report.md`

## Concerns

- `tone` is a stable semantic token (the comment type or `freeform`); rendering should map it to the existing CSS colour variables.
- Placement intentionally preserves input order and does not filter resolved comments; the rendering caller should pass unresolved comments as specified by the brief.
