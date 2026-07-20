# Centre Toolbar-Created Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place every prose, note, and figure card created from the toolbar at the exact centre of the current canvas viewport.

**Architecture:** Change only the direct toolbar creation path in `App.addCard`. Keep the shared collision-placement functions intact for agent and MCP operations, and replace the obsolete toolbar-stacking browser assertion with a viewport-centre regression covering all three card kinds.

**Tech Stack:** TypeScript, React, tldraw 3.15, Playwright, Vitest.

---

### Task 1: Centre direct toolbar card creation

**Files:**
- Modify: `e2e/cards.spec.ts:9-28`
- Modify: `src/App.tsx:17,642-662`

- [ ] **Step 1: Replace the toolbar-stacking test with failing viewport-centre regressions**

Replace `toolbar-created cards stack vertically with a 24px gap` with:

```ts
for (const card of [
  { name: 'prose', button: 'new-prose', selector: '.elves-card--prose' },
  { name: 'note', button: 'new-note', selector: '.elves-card--note' },
  { name: 'figure', button: 'new-figure', selector: '.elves-card--figure' },
] as const) {
  test(`toolbar-created ${card.name} cards appear at the viewport centre`, async ({ page }) => {
    await page.goto('/')
    const canvas = page.locator('.tl-canvas')
    await expect(canvas).toBeVisible({ timeout: 15000 })

    // Leave a card at the centre. The next card must stay visible there rather
    // than being pushed below this obstacle and down the rest of its lane.
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
    await page.getByTestId(card.button).click()

    const created = page.locator(card.selector).last()
    await expect(created).toBeVisible()
    const [canvasBox, cardBox] = await Promise.all([
      canvas.boundingBox(),
      created.boundingBox(),
    ])
    if (!canvasBox || !cardBox) throw new Error('canvas or created card has no bounds')

    expect(Math.abs(
      cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
    )).toBeLessThanOrEqual(2)
    expect(Math.abs(
      cardBox.y + cardBox.height / 2 - (canvasBox.y + canvasBox.height / 2),
    )).toBeLessThanOrEqual(2)
  })
}
```

- [ ] **Step 2: Run the focused browser regression and verify RED**

Run:

```bash
ELVES_E2E_SERVER_PORT=58699 ELVES_E2E_WEB_PORT=58673 ELVES_DATA=/private/tmp/elves-centre-cards-red npm run e2e -- e2e/cards.spec.ts
```

Expected: the three new viewport-centre tests fail their vertical-centre assertions because `clearCardPosition` moves the second card below the first.

- [ ] **Step 3: Make toolbar placement use the viewport centre directly**

Remove this now-unused import from `src/App.tsx`:

```ts
import { clearCardPosition } from './client/canvasLayout'
```

Replace the collision-cleared coordinates inside `addCard`:

```ts
const at = clearCardPosition(editor, {
  x: center.x - props.w / 2,
  y: center.y - props.h / 2,
  w: props.w,
  h: props.h,
})
```

and:

```ts
x: at.x,
y: at.y,
```

with direct centred coordinates:

```ts
x: center.x - props.w / 2,
y: center.y - props.h / 2,
```

Do not change `clearCardPosition`, `placeBelowObstacles`, or the change-set applicators.

- [ ] **Step 4: Re-run the focused browser regression and verify GREEN**

Run:

```bash
ELVES_E2E_SERVER_PORT=58699 ELVES_E2E_WEB_PORT=58673 ELVES_DATA=/private/tmp/elves-centre-cards-green npm run e2e -- e2e/cards.spec.ts
```

Expected: every test in `e2e/cards.spec.ts` passes, including prose, note, and figure viewport-centre coverage.

- [ ] **Step 5: Run focused unit protection for the unchanged agent placement rule**

Run:

```bash
npm test -- tests/model/layout.test.ts tests/apply/applyChangeSet.test.ts
```

Expected: both files pass; collision-safe placement remains protected for agent operations.

- [ ] **Step 6: Commit the implementation**

```bash
git add e2e/cards.spec.ts src/App.tsx
git commit -m "fix(canvas): centre new cards in the viewport"
```
