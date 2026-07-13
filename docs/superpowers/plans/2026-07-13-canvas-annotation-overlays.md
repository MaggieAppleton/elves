# Canvas Annotation and Overlay Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent agent questions and merged-card peeks from overlapping or blocking canvas cards.

**Architecture:** Questions become ordinary occupancy obstacles in both applicators. Merged fans stay ephemeral but use a pure candidate-slot helper and measured overlay size to select clear space.

**Tech Stack:** TypeScript, React, tldraw, Vitest, Playwright.

---

### Task 1: Question occupancy

**Files:**
- Modify: `src/client/canvasLayout.ts`
- Modify: `src/apply/applyChangeSet.ts`
- Modify: `server/applyChangeSet.ts`
- Modify: `tests/apply/applyChangeSet.test.ts`
- Modify: `tests/server/changeset.test.ts`

- [ ] **Step 1: Add failing duplicate-position tests**

```ts
test('duplicate-position questions stack with a 24px gap', () => {
  const next = applyChangeSetToSnapshot(snapshot, {
    id: 'q', author: 'claude', ops: [
      { kind: 'create_question', text: 'One?', x: 0, y: 0 },
      { kind: 'create_question', text: 'Two?', x: 0, y: 0 },
    ],
  })!
  const questions = questionRecords(next).sort((a, b) => a.y - b.y)
  expect(questions[1].y).toBe(questions[0].y + questions[0].props.h + 24)
})
```

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: both questions remain at y 0.

- [ ] **Step 3: Include visible questions and occupied card heights in obstacle adapters**

Dismissed questions and merged-away cards are excluded. Create questions with `placeBelowObstacles` before insertion.

- [ ] **Step 4: Run and observe GREEN, then commit**

Run: `npm test -- tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: focused tests pass.

```bash
git add src/client/canvasLayout.ts src/apply/applyChangeSet.ts server/applyChangeSet.ts tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts
git commit -m "fix(layout): place questions clear of canvas items"
```

### Task 2: Overlay slot helper

**Files:**
- Modify: `src/model/layout.ts`
- Modify: `tests/model/layout.test.ts`

- [ ] **Step 1: Add failing candidate-order tests**

```ts
test('uses the left slot when the right slot is occupied', () => {
  expect(findOverlaySlot(
    { x: 100, y: 100, w: 100, h: 80 },
    { w: 100, h: 60 },
    [{ x: 224, y: 100, w: 100, h: 80 }],
  )).toMatchObject({ x: -24, y: 100 })
})
```

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- tests/model/layout.test.ts`
Expected: `findOverlaySlot` is missing.

- [ ] **Step 3: Implement right/left/below/above candidates and downward fallback**

Each candidate leaves `CANVAS_GAP`. The first non-conflicting candidate wins; otherwise call `placeBelowObstacles` from the right-hand candidate.

- [ ] **Step 4: Run and observe GREEN, then commit**

Run: `npm test -- tests/model/layout.test.ts`
Expected: layout tests pass.

```bash
git add src/model/layout.ts tests/model/layout.test.ts
git commit -m "feat(layout): choose clear slots for canvas overlays"
```

### Task 3: Adaptive merged fan

**Files:**
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/shapes/card.css`
- Modify: `e2e/questions.spec.ts`
- Modify: `e2e/changes.spec.ts`

- [ ] **Step 1: Add failing Playwright regressions**

For questions, create two at identical coordinates and assert their DOM rectangles do not intersect and have a 24-pixel gap. For merges, place a neighbour to the representative's right, expand the fan, and assert the rectangles do not intersect; `document.elementFromPoint` inside the neighbour must resolve to the neighbour's shape id.

- [ ] **Step 2: Run and observe RED**

Run: `ELVES_E2E_SERVER_PORT=58499 ELVES_E2E_WEB_PORT=58473 ELVES_DATA=/private/tmp/elves-overlay-layout-e2e npm run e2e -- e2e/questions.spec.ts e2e/changes.spec.ts`
Expected: duplicate questions overlap and the fan intercepts the neighbour.

- [ ] **Step 3: Measure and position the merged fan**

Attach a ref to `.elves-merge-fan`. In a layout effect, convert its measured width/height to page units, collect visible card/question occupied rectangles, call `findOverlaySlot`, and store the relative x/y offset in ephemeral component state. Replace the fixed CSS `left` and `top` with the measured inline offset.

- [ ] **Step 4: Run Playwright, full verification, and commit**

Run: `ELVES_E2E_SERVER_PORT=58499 ELVES_E2E_WEB_PORT=58473 ELVES_DATA=/private/tmp/elves-overlay-layout-e2e npm run e2e -- e2e/questions.spec.ts e2e/changes.spec.ts`
Expected: both specs pass.

Run: `npm test && npm run typecheck && npm run build`
Expected: all commands exit 0.

```bash
git add src/shapes/CardShapeUtil.tsx src/shapes/card.css e2e/questions.spec.ts e2e/changes.spec.ts
git commit -m "fix(layout): keep annotation overlays clear"
```

