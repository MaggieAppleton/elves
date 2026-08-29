# Threaded Annotation Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every annotation as a compact, independent type pin and let users converse with Claude in durable annotation threads.

**Architecture:** Pin presentation is derived from existing annotations and delegates hover/popover and inspector content to one shared `AnnotationThread` component. A second slice evolves the existing comment/feedback records into backwards-compatible thread messages, adds thread changeset operations, and runs Claude through a dedicated per-thread client protocol.

**Tech Stack:** TypeScript, React 18, tldraw, Express, Vitest, react-test-renderer, Playwright.

---

## File structure

- `src/model/annotationPins.ts`: icon tokens and deterministic per-card pin placement.
- `src/components/AnnotationThread.tsx`: reusable read-only/popover/inspector thread UI; Task 1 keeps reply controls disabled.
- `src/shapes/AnnotationPin.tsx`, `annotationPin.css`: one pin per open annotation, hover/focus full-thread popover.
- `src/model/types.ts`, `src/model/comments.ts`, `src/model/feedback.ts`: thread message schema and legacy migration helpers.
- `src/client/annotationThread.ts`, `server/app.ts`: durable reply and immediate Claude-run protocol.

### Task 1: Pin tokens and deterministic placement

**Files:**
- Create: `src/model/annotationPins.ts`
- Test: `tests/model/annotationPins.test.ts`

- [ ] **Step 1: Write failing token/placement tests**

```ts
import { annotationPin, cardAnnotationPins } from '../../src/model/annotationPins'

test('structure has a stable branch icon and colour token', () => {
  expect(annotationPin('structure')).toEqual({ icon: 'branch', tone: 'structure', label: 'Structure' })
})
test('card pins are one-per-comment and vertically non-overlapping', () => {
  expect(cardAnnotationPins([{ id: 'a' }, { id: 'b' }] as any)).toEqual([
    { commentId: 'a', offsetY: 0 }, { commentId: 'b', offsetY: 36 },
  ])
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run tests/model/annotationPins.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure pin contract**

```ts
export const PIN_GAP = 8
export const PIN_SIZE = 28
export function cardAnnotationPins(comments: readonly { id: string }[]) {
  return comments.map((comment, index) => ({ commentId: comment.id, offsetY: index * (PIN_SIZE + PIN_GAP) }))
}
```

Map all `CommentType | null` values to readable icon/tone/label data; no component imports are permitted.

- [ ] **Step 4: Run focused test**

Run: `npx vitest run tests/model/annotationPins.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/annotationPins.ts tests/model/annotationPins.test.ts
git commit -m "feat(annotations): define per-comment pin tokens"
```

### Task 2: Independent pins and shared read-only thread surface

**Files:**
- Create: `src/components/AnnotationThread.tsx`
- Create: `src/components/annotationThread.css`
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/shapes/FeedbackShapeUtil.tsx`
- Modify: `src/components/AnnotationRail.tsx`
- Modify: `src/shapes/card.css`
- Modify: `src/shapes/feedback.css`
- Test: `tests/components/AnnotationThread.test.ts`
- Test: `e2e/comments.spec.ts`

- [ ] **Step 1: Add failing component and browser tests**

```tsx
test('each open card comment renders an independent pin', async ({ page, request }) => {
  await addTwoComments(page, request)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(2)
  const boxes = await page.getByTestId('annotation-pin').evaluateAll((pins) => pins.map((p) => p.getBoundingClientRect().y))
  expect(new Set(boxes).size).toBe(2)
})
test('focus exposes the complete thread without opening the rail', () => {
  // AnnotationThread receives a legacy comment and renders full text, attribution, resolve only.
})
```

- [ ] **Step 2: Verify red state**

Run: `npm run e2e -- e2e/comments.spec.ts`

Expected: FAIL because the aggregate marker still renders once per card.

- [ ] **Step 3: Render pins and shared thread**

Create `AnnotationThread` with `mode: 'popover' | 'rail'`, a full initial comment, attribution, an accessible resolve action, and no reply input in this slice. Render every `visibleComments` entry as a 28px `annotation-pin` at `right: -36px; top: offsetY`; the pin’s `:hover` and `:focus-within` reveal an adjacent full-thread popover. Click calls the existing exact comment target selection bridge. Replace aggregate marker layout reservation with `commentH: 0`, since pins live beside the card rather than below it. Feedback uses one identically styled pin at its own coordinate.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run tests/components/AnnotationThread.test.ts && npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts && npm run typecheck`

Expected: PASS; pins are compact at all zooms, do not overlap, hover/focus reveals full content, and click opens the same rail thread.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnnotationThread.tsx src/components/annotationThread.css src/shapes/CardShapeUtil.tsx src/shapes/FeedbackShapeUtil.tsx src/components/AnnotationRail.tsx src/shapes/card.css src/shapes/feedback.css tests/components/AnnotationThread.test.ts e2e/comments.spec.ts
git commit -m "feat(annotations): render threaded comment pins"
```

### Task 3: Durable user–Claude threads and immediate replies

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/model/comments.ts`
- Modify: `src/model/feedback.ts`
- Modify: `src/model/changeset.ts`
- Modify: `src/client/annotationThread.ts`
- Modify: `server/app.ts`
- Modify: `src/components/AnnotationThread.tsx`
- Modify: `src/components/AnnotationRail.tsx`
- Test: `tests/model/comments.test.ts`
- Test: `tests/server/api.test.ts`
- Test: `tests/components/AnnotationThread.test.ts`
- Test: `e2e/comments.spec.ts`

- [ ] **Step 1: Add failing migration and reply tests**

```ts
test('legacy comments become a single Claude message', () => {
  expect(commentThread(makeComment('c1', 'Needs evidence'))).toMatchObject({ messages: [{ author: 'claude', text: 'Needs evidence' }] })
})
test('sending a reply persists it before the Claude response', async () => {
  await sendReply('c1', 'Which source?')
  expect(thread.messages.map((m) => m.author)).toEqual(['claude', 'user'])
})
```

- [ ] **Step 2: Verify red state**

Run: `npm test -- tests/model/comments.test.ts tests/server/api.test.ts`

Expected: FAIL because annotation messages and the reply operation do not exist.

- [ ] **Step 3: Add backwards-compatible thread data and API**

Define `AnnotationMessage = { id: string; author: 'user' | string; text: string; createdAt: string }`; add optional `messages` to comments and feedback, and `threadMessages` that emits legacy initial Claude content when absent. Add an append-reply changeset/API operation that rejects empty text and appends once by message id. Add a thread-run endpoint which accepts annotation target plus persisted message id, serializes one active run per target, invokes the existing agent executor with target context/thread history, and appends one Claude message only after the completed reply. Return retry-safe errors without dropping the user message.

- [ ] **Step 4: Connect the thread UI**

`AnnotationThread` enables its reply textarea in both popover and rail modes. On send: generate id, persist user message, set local running state, start the thread run, stream visible interim prose, and reconcile the final persisted Claude message. Disable only that thread’s send control while active; resolve/close remain available. Retry reuses the persisted newest user message and never appends it again.

- [ ] **Step 5: Run full verification**

Run: `npm test -- tests/model/comments.test.ts tests/server/api.test.ts tests/components/AnnotationThread.test.ts && npm run typecheck && npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts`

Expected: PASS; user reply is durable, Claude answers immediately in the same thread, retry does not duplicate, pins and inspector stay synchronized.

- [ ] **Step 6: Commit**

```bash
git add src/model/types.ts src/model/comments.ts src/model/feedback.ts src/model/changeset.ts src/client/annotationThread.ts server/app.ts src/components/AnnotationThread.tsx src/components/AnnotationRail.tsx tests/model/comments.test.ts tests/server/api.test.ts tests/components/AnnotationThread.test.ts e2e/comments.spec.ts
git commit -m "feat(annotations): add Claude reply threads"
```
