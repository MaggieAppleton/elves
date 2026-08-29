# Task 3 — durable annotation threads

## Commit

- `6729e1f feat(annotations): add Claude reply threads`

## Delivered

- Backwards-compatible annotation messages: legacy comments and feedback project to their original Claude turn; replies append by message id.
- An idempotent `append_annotation_message` changeset operation, applied consistently in the server snapshot and active editor paths.
- A per-target annotation-run SSE endpoint. It requires a persisted user-message id, streams interim text, holds one active run for that target, and persists one Claude reply only when the run completes.
- Reply client helpers and shared rail/popover controls. A reply is persisted before its run starts; retry starts another scoped run using the same persisted user message id.

## Verification

- `npm test -- tests/model/comments.test.ts tests/server/api.test.ts tests/components/AnnotationThread.test.ts` — passed (53 tests).
- `npm run typecheck` — passed.
- `npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts` — could not start inside the sandbox because tsx could not create its system temporary IPC socket. Retried with approval on isolated ports. The browser then opened the empty-project screen after `resetProject`, so the suite did not reach an annotation assertion. The focused failure is recorded in `test-results/.../error-context.md`; it is an E2E server/project setup issue to resolve before claiming browser coverage.

## Concerns

- The persisted reply protocol has focused model/server/component coverage, but the requested Playwright coverage remains blocked by the test harness setup above.
