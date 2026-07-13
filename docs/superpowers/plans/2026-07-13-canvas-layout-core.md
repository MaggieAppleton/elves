# Canvas Layout Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give toolbar and agent card operations one shared 24-pixel, collision-safe placement rule.

**Architecture:** Pure rectangle functions live in `src/model/layout.ts`. Small client and server adapters translate tldraw/editor records into those rectangles; UI and change-set paths call the same pure rule.

**Tech Stack:** TypeScript, React, tldraw 3.15, Vitest, Playwright.

---

### Task 1: Gap-aware placement primitive

**Files:**
- Modify: `src/model/layout.ts`
- Modify: `tests/model/layout.test.ts`

- [ ] **Step 1: Write failing model tests**

```ts
test('places a colliding rectangle exactly 24px below the obstacle', () => {
  expect(placeBelowObstacles(
    { x: 0, y: 20, w: 100, h: 50 },
    [{ x: 0, y: 0, w: 100, h: 50 }],
  )).toMatchObject({ x: 0, y: 74 })
})

test('walks past a stack of obstacles', () => {
  expect(placeBelowObstacles(
    { x: 0, y: 0, w: 100, h: 50 },
    [{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 74, w: 100, h: 50 }],
  ).y).toBe(148)
})
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `npm test -- tests/model/layout.test.ts`
Expected: FAIL because `placeBelowObstacles` is not exported.

- [ ] **Step 3: Implement the pure primitive**

```ts
export const CANVAS_GAP = 24
export interface LayoutRect { x: number; y: number; w: number; h: number }

export function conflictsWithGap(a: LayoutRect, b: LayoutRect, gap = CANVAS_GAP): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
}

export function placeBelowObstacles(rect: LayoutRect, obstacles: LayoutRect[]): LayoutRect {
  const placed = { ...rect }
  for (let i = 0; i <= obstacles.length; i++) {
    const hits = obstacles.filter((item) => conflictsWithGap(placed, item))
    if (!hits.length) return placed
    placed.y = Math.max(...hits.map((item) => item.y + item.h)) + CANVAS_GAP
  }
  return placed
}
```

- [ ] **Step 4: Run the focused tests and observe GREEN**

Run: `npm test -- tests/model/layout.test.ts`
Expected: all layout tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/model/layout.ts tests/model/layout.test.ts
git commit -m "feat(layout): add shared 24px placement primitive"
```

### Task 2: Client and server adapters

**Files:**
- Create: `src/client/canvasLayout.ts`
- Modify: `src/apply/applyChangeSet.ts`
- Modify: `server/applyChangeSet.ts`
- Modify: `tests/apply/applyChangeSet.test.ts`
- Modify: `tests/server/changeset.test.ts`

- [ ] **Step 1: Add failing tests for create and move operations**

```ts
test('move_cards clears a stationary card by 24px', () => {
  const ed = fakeEditor([noteCard('a'), { ...noteCard('b'), y: 200 }])
  applyChangeSet(ed as unknown as Editor, cs([
    { kind: 'move_cards', moves: [{ cardId: 'b', x: 0, y: 0 }] },
  ]))
  expect(ed._shapes.get('b')).toMatchObject({ x: 0, y: 84 })
})
```

Add the equivalent snapshot assertion in `tests/server/changeset.test.ts`, using a 60-pixel card body and expecting y `84`.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: moved cards retain the colliding requested y.

- [ ] **Step 3: Add adapters and replace duplicate placement code**

`src/client/canvasLayout.ts` exports `cardObstacles(editor, excludedIds)` and `clearCardPosition(editor, rect, excludedIds)`. Both applicators exclude hidden merged cards and the full moving set, then add each newly placed rectangle to the obstacle list before processing the next move.

```ts
const placed = placeBelowObstacles(
  { x: requested.x, y: requested.y, w: shape.props.w, h: shape.props.h },
  obstacles,
)
```

- [ ] **Step 4: Run focused tests and observe GREEN**

Run: `npm test -- tests/model/layout.test.ts tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts`
Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/canvasLayout.ts src/apply/applyChangeSet.ts server/applyChangeSet.ts tests/apply/applyChangeSet.test.ts tests/server/changeset.test.ts
git commit -m "feat(layout): share collision-safe card placement"
```

### Task 3: Toolbar stacking and browser regression

**Files:**
- Modify: `src/App.tsx`
- Modify: `e2e/cards.spec.ts`

- [ ] **Step 1: Add a failing Playwright test**

```ts
test('toolbar-created cards stack vertically with a 24px gap', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
  }
  const boxes = await page.locator('.elves-card').evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect()).sort((a, b) => a.y - b.y),
  )
  expect(Math.round(boxes[1].y - boxes[0].bottom)).toBe(24)
  expect(Math.round(boxes[2].y - boxes[1].bottom)).toBe(24)
})
```

- [ ] **Step 2: Run the test and observe RED**

Run: `ELVES_E2E_SERVER_PORT=58299 ELVES_E2E_WEB_PORT=58273 ELVES_DATA=/private/tmp/elves-layout-core-e2e npm run e2e -- e2e/cards.spec.ts`
Expected: gap assertions fail because cards overlap by 90 pixels.

- [ ] **Step 3: Use `clearCardPosition` in `addCard`**

Keep `cascadeOffset` for sections. For cards, build the centred desired rectangle, pass it through the client layout adapter, and create the card at the returned x/y.

- [ ] **Step 4: Run Playwright and unit tests**

Run: `ELVES_E2E_SERVER_PORT=58299 ELVES_E2E_WEB_PORT=58273 ELVES_DATA=/private/tmp/elves-layout-core-e2e npm run e2e -- e2e/cards.spec.ts`
Expected: cards spec passes.

Run: `npm test`
Expected: 52 test files pass.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx e2e/cards.spec.ts
git commit -m "fix(canvas): stack new cards with a 24px gap"
```
