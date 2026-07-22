# Draft Prose Rail Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor each active prose card's blue focus rail to the left edge of the linear draft pane while retaining card-height and the existing reading-column geometry.

**Architecture:** Turn the draft body into a full-width grid with a centered reading track. Prose state containers span the full grid and place their text back in the reading track, allowing their focus rail to use pane-edge coordinates without measurement code.

**Tech Stack:** React 18, CSS Grid, TypeScript, Playwright, Vitest

## Global Constraints

- The rail remains exactly the active prose card's height.
- The rail sits on the draft pane's left edge in split and full-draft views.
- Preserve paragraph measure, wrapping, headings, figures, images, vertical rhythm, editing behavior, and keyboard order.
- Use the existing focus-ring colour and two-pixel rail width.
- Add no runtime JavaScript measurement or new dependencies.

---

### Task 1: Pane-edge prose focus rail

**Files:**
- Modify: `src/components/DraftPane.tsx`
- Modify: `src/components/draft.css`
- Test: `e2e/draft.spec.ts`

**Interfaces:**
- Consumes: `.elves-draft-pane`, `.elves-draft__body`, `.elves-draft__prose-row`, `.elves-draft__editor`, and the existing split/draft view controls.
- Produces: a shared full-width prose state container whose rail is pane-aligned and whose content remains reading-column-aligned.

- [ ] **Step 1: Write the failing geometry test**

Add a Playwright helper that derives the active rail geometry from the focused prose container's bounding box and asserts:

```ts
const paneBox = await page.locator('.elves-draft-pane').boundingBox()
const proseBox = await page.getByTestId('draft-para').boundingBox()
expect(proseBox?.x).toBeCloseTo(paneBox?.x ?? 0, 0)
expect(proseBox?.height).toBeGreaterThan(0)
```

Exercise the assertion while the edit target is keyboard-focused and while the textarea is active, in both split and full-draft views. Also record the paragraph text rectangle before focus and assert its `x` and `width` are unchanged after entering edit mode.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx playwright test e2e/draft.spec.ts --grep "prose focus rail"
```

Expected: FAIL because `.elves-draft__prose-row` currently begins at the centered reading-column edge rather than the draft pane edge.

- [ ] **Step 3: Implement the full-width state container**

In `DraftPane.tsx`, wrap `ProseEditor` with the same state-container class used for resting prose rows. In `draft.css`, define a full-width draft grid and a named centered reading track. Make prose state containers span the full grid, place their paragraph/editor content in the reading track, and move the existing focus shadow from the text element to the full-width container. Do not change the typography or visual-card rules.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
npx playwright test e2e/draft.spec.ts --grep "prose focus rail"
npx vitest run tests/components/DraftPane.test.ts
npm run typecheck
```

Expected: all commands exit 0; the new geometry assertions pass in both views and both prose states.

- [ ] **Step 5: Verify the production surface**

Run:

```bash
npm test
npm run build
npx playwright test e2e/draft.spec.ts
```

Expected: all commands exit 0 with no test failures.

- [ ] **Step 6: Commit**

```bash
git add src/components/DraftPane.tsx src/components/draft.css e2e/draft.spec.ts
git commit -m "fix: align draft prose rail to pane edge"
```
