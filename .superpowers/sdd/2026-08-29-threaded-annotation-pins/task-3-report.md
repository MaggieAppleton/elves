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

## Fix round 2/5

- Replaced the singleton App thread state with a stable target-keyed state map. Target updates, completion cleanup, streaming, errors, and retries now affect only the matching card-comment or feedback key.
- Presentation publication now reconciles map entries independently, so starting target B cannot clear target A's running popover state.
- Added a two-target component regression: when A is active and B starts, both popover send controls remain disabled.
- Verification: `npm test -- tests/model/comments.test.ts tests/server/api.test.ts tests/server/agentRoutes.test.ts tests/components/AnnotationThread.test.ts tests/components/AnnotationRail.test.ts` passed (78 tests); `npm run typecheck` passed.

## Final review consolidation

- Card-comment tldraw schema and migration now accept/preserve `messages`, including legacy-to-threaded snapshot projection.
- Annotation retries use the durable user-message id as their run/reply identity. The server returns an already-persisted response for that exact turn, prevents a concurrent duplicate, and derives history only before the requested user message.
- Client SSE handling requires an explicit terminal frame; a dropped stream becomes a retryable error instead of a silent success. Server admission failures now surface a retryable stream error rather than claiming persistence.
- Reply-only runs carry an empty tool allowlist plus an explicit elves MCP deny rule. Canvas locks disable reply forms without clearing a typed draft.
- Feedback is a 28 × 28 saved-coordinate pin/hitbox with its own scale origin. Resolved card comments are indexed in Review home, open in the shared rail, and can be restored. Pin names include a bounded annotation-text gist.
- Updated stale browser selectors and added the resolved-card recovery scenario. Target state/run keys are project-scoped in App/server; project transitions synchronously clear the published pin state.

### Verification

- `npm run typecheck` — passed.
- Focused Task 3 coverage: `npm test -- tests/client/annotationThread.test.ts tests/client/annotationSelection.test.ts tests/model/feedback.test.ts tests/shapes/migration.test.ts tests/components/AnnotationThread.test.ts tests/components/AnnotationRail.test.ts tests/server/agentRun.test.ts tests/server/agentRoutes.test.ts tests/server/api.test.ts` — 9 files, 147 tests passed.
- Full suite (outside sandbox because server-route tests bind localhost): `npm test` — 94 files, 1,389 tests passed.
- Browser attempt on isolated ports: `ELVES_E2E_SERVER_PORT=5299 ELVES_E2E_WEB_PORT=5298 ELVES_E2E_BASE=http://localhost:5299 npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts`. The web/server processes started, but the first canvas tests stopped at `No projects yet` after `resetProject`, before any annotation assertion. This remains an E2E bootstrap issue; the source scenarios are updated but cannot be claimed as browser-verified.
