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

## Fix round 1/5

- Pin popovers now subscribe to the same target-keyed presentation state as the rail, including running, streamed text, error, and retry. The reply form has a local send latch as well as the running disablement, so double submits cannot append duplicate user messages.
- Feedback now registers optional `messages` in its tldraw shape schema, initializes new feedback with an empty message list, and supplies persisted messages to both pin popovers and the rail.
- `/annotations/run` now finds the specific persisted user message requested by id, derives history only from turns before it, and uses that exact text in Claude's prompt.
- Verification: `npm test -- tests/model/comments.test.ts tests/server/api.test.ts tests/server/agentRoutes.test.ts tests/components/AnnotationThread.test.ts tests/components/AnnotationRail.test.ts` passed (77 tests); `npm run typecheck` passed.
