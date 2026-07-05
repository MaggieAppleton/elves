# Draft Drawer Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-button Canvas/Split/Draft segmented control with a directional chevron "drawer handle" anchored to the draft pane's edge (« = more draft, » = less draft).

**Architecture:** The underlying view state machine (`'canvas' | 'split' | 'draft'` + `split` ratio, persisted per project) is untouched — this is a presentation swap. Step logic is extracted into a pure, unit-tested module `src/client/viewMachine.ts`. A new presentational `DraftDrawerControls.tsx` renders the reachable chevrons for the current state, mounted once inside `.elves-stage` so it positions itself relative to the panes/divider. `ViewToggle.tsx` + `viewToggle.css` are removed. Behavior is verified via Playwright e2e (vitest runs in `node` env, so no React component unit tests).

**Tech Stack:** React 18, TypeScript, tldraw, Vite, Vitest (node env), Playwright.

---

## File Structure

- **Create** `src/client/viewMachine.ts` — pure view-state vocabulary: `ViewState`, `VIEW_ORDER`, `moreDraft()`, `lessDraft()`, `canExpand()`, `canCollapse()`. The single source of truth for the sequence.
- **Create** `tests/client/viewMachine.test.ts` — unit tests for the step helpers.
- **Create** `src/components/DraftDrawerControls.tsx` — presentational chevron handle. Props: `{ view, split, onExpand, onCollapse }`. Renders the canvas tab, split handle, or full handle depending on `view`.
- **Modify** `src/App.tsx` — swap the import + component, add `expandDraft`/`collapseDraft`, make the keyboard shortcut directional, add `data-view` to the stage for testable assertions.
- **Modify** `src/theme.css` — add drawer handle/tab styles near the divider rules.
- **Delete** `src/components/ViewToggle.tsx`, `src/components/viewToggle.css`.
- **Modify** `e2e/draft.spec.ts` — drive the new chevrons + assert via `[data-view]`.

---

## Task 1: Pure view-machine module

**Files:**
- Create: `src/client/viewMachine.ts`
- Test: `tests/client/viewMachine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/client/viewMachine.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  VIEW_ORDER,
  moreDraft,
  lessDraft,
  canExpand,
  canCollapse,
} from '../../src/client/viewMachine'

test('VIEW_ORDER is canvas → split → draft', () => {
  expect(VIEW_ORDER).toEqual(['canvas', 'split', 'draft'])
})

test('moreDraft steps one toward draft and clamps at draft', () => {
  expect(moreDraft('canvas')).toBe('split')
  expect(moreDraft('split')).toBe('draft')
  expect(moreDraft('draft')).toBe('draft')
})

test('lessDraft steps one toward canvas and clamps at canvas', () => {
  expect(lessDraft('draft')).toBe('split')
  expect(lessDraft('split')).toBe('canvas')
  expect(lessDraft('canvas')).toBe('canvas')
})

test('canExpand is false only at draft; canCollapse is false only at canvas', () => {
  expect(canExpand('canvas')).toBe(true)
  expect(canExpand('split')).toBe(true)
  expect(canExpand('draft')).toBe(false)
  expect(canCollapse('canvas')).toBe(false)
  expect(canCollapse('split')).toBe(true)
  expect(canCollapse('draft')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- viewMachine`
Expected: FAIL — cannot resolve `../../src/client/viewMachine`.

- [ ] **Step 3: Write minimal implementation**

Create `src/client/viewMachine.ts`:

```ts
/** Canvas only · split · draft only — the three ways to look at a piece. */
export type ViewState = 'canvas' | 'split' | 'draft'

/** The 1-D sequence the drawer moves along. Index 0 = least draft. */
export const VIEW_ORDER: ViewState[] = ['canvas', 'split', 'draft']

/** One step toward more draft (« pulls the drawer wider). Clamps at 'draft'. */
export function moreDraft(v: ViewState): ViewState {
  return VIEW_ORDER[Math.min(VIEW_ORDER.length - 1, VIEW_ORDER.indexOf(v) + 1)]
}

/** One step toward less draft (» pushes the drawer closed). Clamps at 'canvas'. */
export function lessDraft(v: ViewState): ViewState {
  return VIEW_ORDER[Math.max(0, VIEW_ORDER.indexOf(v) - 1)]
}

/** Can the drawer grow from here? (false only when already full draft) */
export const canExpand = (v: ViewState): boolean => v !== 'draft'

/** Can the drawer shrink from here? (false only when already closed) */
export const canCollapse = (v: ViewState): boolean => v !== 'canvas'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- viewMachine`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client/viewMachine.ts tests/client/viewMachine.test.ts
git commit -m "feat(view): pure view-machine step helpers (moreDraft/lessDraft)"
```

---

## Task 2: DraftDrawerControls component

**Files:**
- Create: `src/components/DraftDrawerControls.tsx`

No unit test (vitest is node-env; the component is exercised by e2e in Task 5).

- [ ] **Step 1: Create the component**

Create `src/components/DraftDrawerControls.tsx`:

```tsx
import type { ViewState } from '../client/viewMachine'

/**
 * Directional drawer handle. The draft pane is a drawer anchored to the right
 * edge; each chevron points the way its edge will travel:
 *   «  more draft  (canvas → split → draft)
 *   »  less draft  (draft → split → canvas)
 * Only the reachable chevrons are shown for the current view.
 */
export function DraftDrawerControls({
  view,
  split,
  onExpand,
  onCollapse,
}: {
  view: ViewState
  split: number
  onExpand: () => void
  onCollapse: () => void
}) {
  // Canvas: drawer closed — a half-hidden tab on the right edge pulls it out.
  if (view === 'canvas') {
    return (
      <div className="elves-drawer-tab">
        <button
          type="button"
          data-testid="draft-open"
          aria-label="Open draft"
          title="Open draft"
          onClick={onExpand}
        >
          <ChevronLeft />
        </button>
      </div>
    )
  }

  // Draft (full): drawer fills the screen — a single » parks at top-left.
  if (view === 'draft') {
    return (
      <div className="elves-drawer-handle elves-drawer-handle--full">
        <button
          type="button"
          data-testid="draft-collapse"
          aria-label="Collapse draft to split"
          title="Collapse draft"
          onClick={onCollapse}
        >
          <ChevronRight />
        </button>
      </div>
    )
  }

  // Split: handle rides the top of the divider (left = the split boundary).
  return (
    <div
      className="elves-drawer-handle elves-drawer-handle--split"
      style={{ left: `${split * 100}%` }}
    >
      <button
        type="button"
        data-testid="draft-expand"
        aria-label="Expand draft to full"
        title="Expand draft"
        onClick={onExpand}
      >
        <ChevronLeft />
      </button>
      <button
        type="button"
        data-testid="draft-collapse"
        aria-label="Close draft"
        title="Close draft"
        onClick={onCollapse}
      >
        <ChevronRight />
      </button>
    </div>
  )
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors from the new file). App.tsx still references the old import — that is fixed in Task 3; if you run typecheck before Task 3 it may still show the old ViewToggle import as valid, which is fine.

- [ ] **Step 3: Commit**

```bash
git add src/components/DraftDrawerControls.tsx
git commit -m "feat(view): add DraftDrawerControls chevron handle component"
```

---

## Task 3: Wire into App, retire ViewToggle

**Files:**
- Modify: `src/App.tsx:31` (import), `:105` (nearby state), `:185-207` (changeView + keyboard), `:499` (old mount), `:550-577` (stage)
- Delete: `src/components/ViewToggle.tsx`, `src/components/viewToggle.css`

- [ ] **Step 1: Replace the import**

In `src/App.tsx`, replace line 31:

```ts
import { ViewToggle, type ViewState, VIEW_ORDER } from './components/ViewToggle'
```

with:

```ts
import { DraftDrawerControls } from './components/DraftDrawerControls'
import { type ViewState, moreDraft, lessDraft } from './client/viewMachine'
```

- [ ] **Step 2: Add expand/collapse helpers**

In `src/App.tsx`, immediately after the `changeView` function (currently ending at line 188), add:

```ts
  // The drawer moves one step at a time: « widens toward draft, » narrows
  // toward canvas. Both clamp at the ends of the sequence.
  const expandDraft = () => changeView(moreDraft(view))
  const collapseDraft = () => changeView(lessDraft(view))
```

- [ ] **Step 3: Make the keyboard shortcut directional**

In `src/App.tsx`, replace the keyboard effect body (lines 196-207). New version:

```ts
  // Keyboard: ⌘/Ctrl + \ widens the drawer (more draft); add Shift to narrow it
  // (less draft). A modifier is required so it never fights typing in a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') {
        e.preventDefault()
        changeView(e.shiftKey ? lessDraft(view) : moreDraft(view))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])
```

- [ ] **Step 4: Remove the old toggle mount, add `data-view` to the stage, mount the new control**

In `src/App.tsx`, delete line 499:

```tsx
      <ViewToggle view={view} onChange={changeView} />
```

Then update the stage container opening tag (line 550) to expose the view for tests:

```tsx
      <div className="elves-stage" ref={stageRef} data-dragging={dragging} data-view={view}>
```

Then, inside `.elves-stage`, immediately after the closing `</div>` of `.elves-draft-pane` (currently line 576) and before the stage's closing `</div>` (line 577), add:

```tsx
        <DraftDrawerControls
          view={view}
          split={split}
          onExpand={expandDraft}
          onCollapse={collapseDraft}
        />
```

- [ ] **Step 5: Delete the retired files**

```bash
git rm src/components/ViewToggle.tsx src/components/viewToggle.css
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If it reports `VIEW_ORDER` unused or `ViewToggle` not found, ensure Step 1 replaced the import fully and no other line references `ViewToggle` or `VIEW_ORDER` (grep: `grep -n "ViewToggle\|VIEW_ORDER" src/App.tsx` should return nothing).

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(view): drive views with directional drawer controls; retire ViewToggle"
```

---

## Task 4: Drawer handle styles

**Files:**
- Modify: `src/theme.css` (after the `.elves-divider` block, around line 291)

- [ ] **Step 1: Add the styles**

In `src/theme.css`, after the `.elves-divider:hover::after` rule (line 291) and before the `@media (prefers-reduced-motion)` block at line 293, insert:

```css
/* ---- Draft drawer handle: directional chevrons on the drawer edge ------- */
/* One control, mounted inside the stage, positioning itself by view. « widens
   the drawer toward full draft, » narrows it toward canvas. */
.elves-drawer-handle,
.elves-drawer-tab {
  position: absolute;
  z-index: 360; /* above the divider (350) */
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--elves-surface);
  border: 1px solid var(--elves-border);
  box-shadow: var(--elves-shadow-md), var(--elves-highlight);
}
/* Split: rides the top of the divider; left is set inline to split * 100%. */
.elves-drawer-handle--split {
  top: 10px;
  transform: translateX(-50%);
}
/* Full draft: parks at the top-left corner. */
.elves-drawer-handle--full {
  top: 10px;
  left: 10px;
}
/* Canvas: a half-hidden tab clinging to the right edge; slides in on hover. */
.elves-drawer-tab {
  top: 12px;
  right: 0;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  transform: translateX(42%);
  transition: transform 160ms ease;
}
.elves-drawer-tab:hover,
.elves-drawer-tab:focus-within {
  transform: translateX(0);
}
.elves-drawer-handle button,
.elves-drawer-tab button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--elves-ink-soft);
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease;
}
.elves-drawer-handle button:hover,
.elves-drawer-tab button:hover {
  background: var(--elves-tertiary);
  color: var(--elves-ink);
}
.elves-drawer-handle button svg,
.elves-drawer-tab button svg {
  width: 15px;
  height: 15px;
  display: block;
}
.elves-drawer-handle button:focus-visible,
.elves-drawer-tab button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--elves-surface), 0 0 0 4px var(--elves-focus-ring);
}
@media (prefers-reduced-motion: reduce) {
  .elves-drawer-tab { transition: none; }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (Vite build completes; no missing `viewToggle.css` import error — that import lived only in the deleted `ViewToggle.tsx`).

- [ ] **Step 3: Commit**

```bash
git add src/theme.css
git commit -m "style(view): drawer handle + edge tab styling"
```

---

## Task 5: Update e2e specs

**Files:**
- Modify: `e2e/draft.spec.ts`

The old specs click `view-split` / `view-draft` and assert `data-active`. The new flow uses `draft-open` (canvas tab «), `draft-expand` (split «), `draft-collapse` (»), and asserts state via `.elves-stage[data-view]`.

- [ ] **Step 1: Update the four tests**

In `e2e/draft.spec.ts`:

Replace the body of `'a prose card shows up live in the draft pane in split view'` after the `pane` poll (lines 39-40):

```ts
  await page.getByTestId('draft-open').click()
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')
```

In `'excluding a prose card drops it from the draft...'`, replace line 54:

```ts
  await page.getByTestId('draft-open').click()
```

Replace the body of `'clicking a draft paragraph in draft-only view opens split (draft → canvas nav)'` (lines 74-79):

```ts
  await page.getByTestId('draft-open').click() // canvas → split
  await page.getByTestId('draft-expand').click() // split → draft (full)
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'draft')

  await page.getByTestId('draft-para').click()
  // Navigation drops draft-only into split so the canvas is visible again.
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')
```

In `'copy as markdown writes the draft to the clipboard'`, replace line 87:

```ts
  await page.getByTestId('draft-open').click()
```

- [ ] **Step 2: Add a test for the full expand/collapse round-trip**

Append to `e2e/draft.spec.ts`:

```ts
test('the drawer chevrons step canvas → split → draft and back', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await addProse(page, 'round trip')

  const stage = page.locator('.elves-stage')
  await expect(stage).toHaveAttribute('data-view', 'canvas')

  await page.getByTestId('draft-open').click()
  await expect(stage).toHaveAttribute('data-view', 'split')

  await page.getByTestId('draft-expand').click()
  await expect(stage).toHaveAttribute('data-view', 'draft')

  await page.getByTestId('draft-collapse').click()
  await expect(stage).toHaveAttribute('data-view', 'split')

  await page.getByTestId('draft-collapse').click()
  await expect(stage).toHaveAttribute('data-view', 'canvas')
})
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run e2e -- draft`
Expected: PASS (all draft specs green). If Playwright browsers are not installed, run `npx playwright install` first. If the dev server is not auto-started by `playwright.config.ts`, start `npm run dev:all` in another shell.

- [ ] **Step 4: Commit**

```bash
git add e2e/draft.spec.ts
git commit -m "test(e2e): drive views via drawer chevrons"
```

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck, unit tests, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS. `grep -rn "ViewToggle\|view-toggle\|viewToggle" src e2e tests` returns nothing.

- [ ] **Step 2: Manual smoke (optional if e2e green)**

Start `npm run dev:all`, open the app: confirm the canvas tab pulls the drawer out to split, « widens to full, » narrows back through split to canvas, drag-to-resize still works in split, and `⌘\` / `⌘⇧\` step the drawer.

- [ ] **Step 3: Final commit if anything adjusted**

```bash
git add -A && git commit -m "chore(view): finalize drawer controls" || echo "nothing to finalize"
```

---

## Self-Review Notes

- **Spec coverage:** control model (Tasks 2-4), « / » semantics (Task 1 helpers + Task 2 chevrons), canvas tab / split handle-at-top / full top-left (Task 2 + Task 4 CSS), drag-to-resize preserved (untouched `onDividerDown`), 320ms slide reused (untouched pane CSS), directional keyboard (Task 3), accessibility labels (Task 2), persistence preserved (untouched `changeView`/effects), tests updated (Task 5). All covered.
- **Type consistency:** `ViewState` sourced from `viewMachine.ts` in both App and the component; `moreDraft`/`lessDraft` names match across Task 1 (def), Task 3 (App usage). `data-testid`s (`draft-open`, `draft-expand`, `draft-collapse`) match between Task 2 (component) and Task 5 (specs). `data-view` on `.elves-stage` set in Task 3, asserted in Task 5.
- **No placeholders:** every step has concrete code/commands.
