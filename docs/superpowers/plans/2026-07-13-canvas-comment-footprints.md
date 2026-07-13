# Canvas Comment Footprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make visible comments part of card occupancy and reflow downstream cards to preserve 24 pixels.

**Architecture:** Cards persist a separate `commentH` extension while retaining `h` as body height. The browser measures the real comment stack; pure layout helpers reflow only horizontally intersecting downstream cards.

**Tech Stack:** TypeScript, React, ResizeObserver, tldraw migrations, Vitest, Playwright.

---

### Task 1: Persisted comment footprint

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/model/cards.ts`
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `tests/model/cards.test.ts`
- Modify: `tests/shapes/migration.test.ts`

- [ ] **Step 1: Add failing factory and migration tests**

```ts
test('new cards start without a comment extension', () => {
  expect(makeProseCardProps().commentH).toBe(0)
})

test('AddCommentHeight migrates legacy cards to zero', () => {
  const props: Record<string, unknown> = {}
  addCommentHeightUp(props)
  expect(props.commentH).toBe(0)
})
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- tests/model/cards.test.ts tests/shapes/migration.test.ts`
Expected: missing `commentH` and migration export.

- [ ] **Step 3: Add `commentH` to CardProps, factories, validator, and migration version 12**

```ts
export function addCommentHeightUp(props: Record<string, unknown>): void {
  props.commentH = 0
}
```

- [ ] **Step 4: Run focused tests and observe GREEN**

Run: `npm test -- tests/model/cards.test.ts tests/shapes/migration.test.ts`
Expected: focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/model/types.ts src/model/cards.ts src/shapes/CardShapeUtil.tsx tests/model/cards.test.ts tests/shapes/migration.test.ts
git commit -m "feat(layout): persist card comment footprints"
```

### Task 2: Local lane reflow

**Files:**
- Modify: `src/model/layout.ts`
- Modify: `tests/model/layout.test.ts`
- Modify: `src/client/canvasLayout.ts`

- [ ] **Step 1: Write failing reflow tests**

```ts
test('reflows only downstream items in the same lane', () => {
  expect(reflowVerticalLane('a', [
    { id: 'a', rect: { x: 0, y: 0, w: 100, h: 140 } },
    { id: 'b', rect: { x: 0, y: 100, w: 100, h: 50 } },
    { id: 'side', rect: { x: 200, y: 100, w: 100, h: 50 } },
  ])).toEqual([{ id: 'b', x: 0, y: 164 }])
})
```

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- tests/model/layout.test.ts`
Expected: `reflowVerticalLane` is missing.

- [ ] **Step 3: Implement deterministic downstream reflow**

Sort same-lane items by y and preserve their order. A positive footprint delta pushes later items down; a negative delta pulls only the contiguous downstream stack up by the released amount.

```ts
export interface LayoutItem { id: string; rect: LayoutRect }
export interface LayoutMove { id: string; x: number; y: number }

export function reflowVerticalLane(
  anchorId: string,
  items: LayoutItem[],
  previousAnchorHeight?: number,
): LayoutMove[]
```

- [ ] **Step 4: Run and observe GREEN**

Run: `npm test -- tests/model/layout.test.ts`
Expected: layout tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/model/layout.ts tests/model/layout.test.ts src/client/canvasLayout.ts
git commit -m "feat(layout): reflow changed card lanes"
```

### Task 3: Measure comments and apply reflow

**Files:**
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/apply/applyChangeSet.ts`
- Modify: `server/applyChangeSet.ts`
- Modify: `tests/apply/applyChangeSet.test.ts`
- Modify: `tests/server/changeset.test.ts`

- [ ] **Step 1: Add failing applicator tests**

Assert that adding a comment updates `commentH` to a conservative estimate on the server and moves an overlapping downstream card to `card.y + card.h + commentH + 24`.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: downstream y remains unchanged.

- [ ] **Step 3: Add measurement and mutation integration**

Use a ref on `.elves-comments` and a `ResizeObserver`. Divide rendered pixels by `editor.getZoomLevel()`, add the 7-pixel top margin, and update `commentH` only when the difference exceeds one pixel. Reflow through the client adapter after the update.

The server estimate uses the same exported constants as the CSS: 19-pixel body lines, 16 pixels vertical padding, 14 pixels for a type label, 6 pixels between comments, and a 7-pixel top margin. Estimate line count from `Math.ceil(text.length / Math.max(12, Math.floor((cardWidth - 48) / 7)))`, then apply the same pure lane reflow.

```ts
export function estimateCommentHeight(comments: Comment[], cardWidth: number): number {
  const visible = comments.filter((comment) => !comment.resolved)
  const charsPerLine = Math.max(12, Math.floor((cardWidth - 48) / 7))
  const boxes = visible.map((comment) =>
    16 + (comment.type ? 14 : 0) + Math.max(1, Math.ceil(comment.text.length / charsPerLine)) * 19,
  )
  return boxes.length ? 7 + boxes.reduce((sum, height) => sum + height, 0) + (boxes.length - 1) * 6 : 0
}
```

- [ ] **Step 4: Run and observe GREEN**

Run: `npm test -- tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shapes/CardShapeUtil.tsx src/apply/applyChangeSet.ts server/applyChangeSet.ts tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts
git commit -m "fix(layout): reserve space for card comments"
```

### Task 4: Playwright regression

**Files:**
- Modify: `e2e/comments.spec.ts`

- [ ] **Step 1: Add a failing geometric regression**

Create two vertically stacked cards, attach two long comments to the first, then compare the comment stack's bottom with the second card's top.

```ts
expect(Math.round(secondBox.y - commentsBox.bottom)).toBe(24)
```

- [ ] **Step 2: Run RED, then run GREEN after the implementation**

Run: `ELVES_E2E_SERVER_PORT=58399 ELVES_E2E_WEB_PORT=58373 ELVES_DATA=/private/tmp/elves-comment-layout-e2e npm run e2e -- e2e/comments.spec.ts`
Expected before implementation: negative gap; expected after implementation: pass.

- [ ] **Step 3: Run the complete suite and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: all commands exit 0.

```bash
git add e2e/comments.spec.ts
git commit -m "test(layout): guard comment-aware card spacing"
```
