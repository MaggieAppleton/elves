# Hover-Revealed Split Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the paired split-view draft chevrons while idle and reveal them when the canvas/draft edge is hovered, dragged, or reached by keyboard focus.

**Architecture:** Keep the current component tree and view-state callbacks. Express visibility as split-only CSS because the divider and handle are already ordered siblings, then verify the browser-computed hover and focus behaviour with Playwright.

**Tech Stack:** React 18, TypeScript, CSS, Playwright, Vitest

---

## Global Constraints

- Change only the paired chevron pill in split view; the canvas-only tab and draft-only collapse control remain visible.
- Use the existing 11px full-height divider as the pointer reveal target.
- Reveal during divider hover, handle hover, handle focus, and divider dragging.
- Keep the pill visible on devices that lack hover or use a coarse pointer.
- Preserve current callbacks, button names, focus rings, keyboard shortcuts, split persistence, and divider drag behaviour.
- Keep focused buttons visible and honour `prefers-reduced-motion`.

## File Structure

- Modify `e2e/draft.spec.ts`: cover the browser-computed idle, divider-hover, handle-hover, click, and keyboard-focus behaviour.
- Modify `src/theme.css`: add fine-pointer split-handle opacity rules and a reduced-motion override.

### Task 1: Reveal the split controls from the shared edge

**Files:**
- Modify: `e2e/draft.spec.ts`
- Modify: `src/theme.css`

- [ ] **Step 1: Write failing pointer and keyboard interaction tests**

Add these tests after the existing drawer-chevron round-trip test in `e2e/draft.spec.ts`:

```ts
test('split controls reveal from the divider and stay revealed under the pointer', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const stage = page.locator('.elves-stage')
  await page.getByTestId('draft-open').click()
  await expect(stage).toHaveAttribute('data-view', 'split')

  const handle = page.locator('.elves-drawer-handle--split')
  const opacity = () => handle.evaluate((element) => getComputedStyle(element).opacity)
  await page.mouse.move(20, 20)
  await expect.poll(opacity).toBe('0')

  await page.getByTestId('draft-divider').hover({ position: { x: 5, y: 20 } })
  await expect.poll(opacity).toBe('1')

  await page.getByTestId('draft-expand').hover()
  await expect.poll(opacity).toBe('1')
  await expect(stage).toHaveAttribute('data-dragging', 'false')
  await page.getByTestId('draft-expand').click()
  await expect(stage).toHaveAttribute('data-view', 'draft')
})

test('keyboard focus reveals idle split controls', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('draft-open').click()
  const handle = page.locator('.elves-drawer-handle--split')
  const opacity = () => handle.evaluate((element) => getComputedStyle(element).opacity)
  await page.mouse.move(20, 20)
  await expect.poll(opacity).toBe('0')

  await page.getByTestId('draft-expand').focus()
  await expect.poll(opacity).toBe('1')
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run e2e -- e2e/draft.spec.ts --grep "split controls"
```

Expected: FAIL because the current split handle has computed opacity `1` while the pointer is away from the divider.

- [ ] **Step 3: Add the minimal split-only visibility rules**

Add after the `.elves-drawer-handle--split` positioning rule in `src/theme.css`:

```css
@media (hover: hover) and (pointer: fine) {
  .elves-drawer-handle--split {
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .elves-divider:hover ~ .elves-drawer-handle--split,
  .elves-stage[data-dragging="true"] .elves-drawer-handle--split,
  .elves-drawer-handle--split:hover,
  .elves-drawer-handle--split:focus-within {
    opacity: 1;
  }
}
```

Extend the existing reduced-motion block with:

```css
.elves-drawer-handle--split { transition: none; }
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm run e2e -- e2e/draft.spec.ts --grep "split controls"
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Run relevant regressions and static verification**

Run:

```bash
npm run e2e -- e2e/draft.spec.ts --grep "drawer chevrons|split controls|active divider drag"
npm test -- tests/client/viewMachine.test.ts tests/client/dividerDrag.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Run the full unit and integration suite**

Run:

```bash
npm test
```

Expected: all tests pass. If the known `reviewRun` concurrency test fails once, rerun `npm test -- tests/server/reviewRun.test.ts` and report both results rather than hiding the initial failure.

- [ ] **Step 7: Review the diff and commit**

Run:

```bash
git diff --check
git diff -- e2e/draft.spec.ts src/theme.css
git add e2e/draft.spec.ts src/theme.css
git commit -m "fix: reveal split controls near divider"
```

Expected: one focused implementation commit with no unrelated files.
