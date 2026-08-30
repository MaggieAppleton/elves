# Canvas Annotation Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inconsistent attached-comment and floating-feedback canvas bodies with one compact marker language and a recoverable, immutable annotation right rail.

**Architecture:** A pure annotation-presentation module converts existing `Comment` and `FeedbackProps` data into bounded marker labels at normal and overview zoom. Shape utilities render those markers and notify `App` of a selected annotation. `App` owns the right-rail lifetime and prior view restoration; the rail reads the selected item from the live tldraw editor and reuses the existing feedback resolve/restore behaviour.

**Tech Stack:** TypeScript, React 18, tldraw 3, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-annotations-and-agent-workbench-design.md`

## Global Constraints

- Agents are the only annotation authors; no reply, edit, reaction, delete or compose UI is permitted.
- Existing persisted `comments` and `feedback` properties remain unchanged.
- At `GIST_ZOOM` and below, annotation markers show type and count only; no unreadable gist text.
- Selecting a marker opens one right rail; a rail close restores the exact prior `ViewState`.
- Resolved annotations remain recoverable from Review home.
- Preserve `/` typing exclusions, comment resolve accessibility names, and current canvas mutation locks.

---

### Task 1: Pure annotation presentation contract

**Files:**
- Create: `src/model/annotations.ts`
- Create: `src/client/annotationSelection.ts`
- Test: `tests/model/annotations.test.ts`
- Test: `tests/client/annotationSelection.test.ts`

**Interfaces:**
- Consumes: `Comment` from `src/model/types.ts`, `FeedbackProps` from `src/model/feedback.ts`, `commentGist` and `mechanicalGist` from `src/model/summary.ts`, `GIST_ZOOM` from `src/shapes/summaryView.ts`.
- Produces: `annotationDisplayMode(zoom): 'detail' | 'overview'`, `attachedAnnotationMarker(comments): AnnotationMarker | null`, `feedbackAnnotationMarker(feedback): AnnotationMarker | null`, and an app-local `subscribeAnnotationOpen(listener)` / `requestAnnotationOpen(target)` bridge. The bridge follows the existing ephemeral `src/client/snapHighlight.ts` pattern: it is not persisted in tldraw records.

- [ ] **Step 1: Write the failing unit tests**

```ts
import { expect, test, vi } from 'vitest'
import { attachedAnnotationMarker, annotationDisplayMode, feedbackAnnotationMarker } from '../../src/model/annotations'
import { requestAnnotationOpen, subscribeAnnotationOpen } from '../../src/client/annotationSelection'

test('attached marker uses first unresolved comment, a bounded gist and total count', () => {
  expect(attachedAnnotationMarker([
    { id: 'one', type: 'needs-evidence', text: 'Needs a source.', resolved: false },
    { id: 'two', type: 'tighten', text: 'Second', resolved: false },
    { id: 'three', type: null, text: 'Resolved', resolved: true },
  ] as any)).toEqual({ type: 'needs-evidence', label: 'Needs a source.', count: 2 })
})

test('overview mode starts at the existing gist threshold', () => {
  expect(annotationDisplayMode(0.6)).toBe('overview')
  expect(annotationDisplayMode(0.61)).toBe('detail')
})

test('resolved feedback has no marker', () => {
  expect(feedbackAnnotationMarker({ text: 'Done', type: 'structure', resolved: true } as any)).toBeNull()
})

test('annotation-open listeners receive the selected target once', () => {
  const receive = vi.fn()
  const unsubscribe = subscribeAnnotationOpen(receive)
  requestAnnotationOpen({ kind: 'feedback', feedbackId: 'shape:feedback' })
  expect(receive).toHaveBeenCalledWith({ kind: 'feedback', feedbackId: 'shape:feedback' })
  unsubscribe()
})
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run tests/model/annotations.test.ts`

Expected: FAIL because `src/model/annotations.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure contract**

```ts
export type AnnotationMarker = { type: CommentType | null; label: string; count: number }

export function annotationDisplayMode(zoom: number): 'detail' | 'overview' {
  return zoom <= GIST_ZOOM ? 'overview' : 'detail'
}

export function attachedAnnotationMarker(comments: Comment[]): AnnotationMarker | null {
  const open = comments.filter((comment) => !comment.resolved)
  if (!open.length) return null
  return { type: open[0].type, label: mechanicalGist(commentGist(open[0]), 48), count: open.length }
}

export function feedbackAnnotationMarker(feedback: Pick<FeedbackProps, 'text' | 'type' | 'resolved'>): AnnotationMarker | null {
  return feedback.resolved ? null : { type: feedback.type, label: mechanicalGist(feedback.text, 48), count: 1 }
}
```

```ts
export type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

const listeners = new Set<(target: AnnotationTarget) => void>()
export const subscribeAnnotationOpen = (listener: (target: AnnotationTarget) => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const requestAnnotationOpen = (target: AnnotationTarget) => listeners.forEach((listener) => listener(target))
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run tests/model/annotations.test.ts tests/client/annotationSelection.test.ts`

Expected: PASS; add cases for model comment summaries, all-resolved comments and null types before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/model/annotations.ts src/client/annotationSelection.ts tests/model/annotations.test.ts tests/client/annotationSelection.test.ts
git commit -m "feat(annotations): add marker presentation contract"
```

### Task 2: Compact canvas markers

**Files:**
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/shapes/FeedbackShapeUtil.tsx`
- Modify: `src/shapes/card.css`
- Modify: `src/shapes/feedback.css`
- Test: `e2e/comments.spec.ts`

**Interfaces:**
- Consumes: `AnnotationMarker` and `annotationDisplayMode` from Task 1.
- Produces: clickable marker buttons with `data-testid="annotation-marker"`; calls `requestAnnotationOpen` with `{ kind: 'card', cardId, commentId }` or `{ kind: 'feedback', feedbackId }`.

- [ ] **Step 1: Add failing marker E2E assertions**

```ts
test('attached comments collapse to one marker and do not expose full bodies at overview zoom', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'A comment that must become a marker.' })
  await page.getByRole('button', { name: /Zoom — 100%/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()
  await page.getByRole('button', { name: /Zoom — 75%/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()
  await expect(page.getByTestId('annotation-marker')).toHaveCount(1)
  await expect(page.locator('.elves-comment__text')).toHaveCount(0)
})
```

- [ ] **Step 2: Run the E2E case to verify it fails**

Run: `npm run e2e -- e2e/comments.spec.ts`

Expected: FAIL because `.elves-comment__text` remains rendered and no annotation marker exists.

- [ ] **Step 3: Render the shared marker in both shape utilities**

```tsx
<button
  type="button"
  className="elves-annotation-marker"
  data-mode={annotationDisplayMode(zoom)}
  data-type={marker.type ?? 'freeform'}
  data-testid="annotation-marker"
  aria-label={`Open ${marker.count} annotation${marker.count === 1 ? '' : 's'}: ${marker.label}`}
  onPointerDown={stopEventPropagation}
  onClick={() => requestAnnotationOpen({ kind: 'card', cardId: shape.id, commentId: comments[0].id })}
>
  <span className="elves-annotation-marker__type">{marker.type ?? 'feedback'}</span>
  {mode === 'detail' && <span className="elves-annotation-marker__label">{marker.label}</span>}
  {marker.count > 1 && <span className="elves-annotation-marker__count">+{marker.count - 1}</span>}
</button>
```

Replace the current exterior `.elves-comments` body stack and floating
`.elves-feedback__text` body with this shared compact language. Preserve direct
resolve controls only in the future rail; markers themselves only open detail.
Replace the current DOM-measured `commentH` effect with the marker's CSS height
divided by `editor.getZoomLevel()`, so every card reserves one bounded row and
the existing `reflowCardLane` calls retain their contract.

- [ ] **Step 4: Run focused verification**

Run: `npm run e2e -- e2e/comments.spec.ts e2e/gist-overflow.spec.ts`

Expected: PASS; comments no longer overlap a following card at 100%, and the
overview view exposes markers with no tiny body copy.

- [ ] **Step 5: Commit**

```bash
git add src/shapes/CardShapeUtil.tsx src/shapes/FeedbackShapeUtil.tsx src/shapes/card.css src/shapes/feedback.css e2e/comments.spec.ts
git commit -m "feat(annotations): render compact canvas markers"
```

### Task 3: Annotation right rail and recovered history

**Files:**
- Create: `src/components/AnnotationRail.tsx`
- Create: `src/components/annotationRail.css`
- Modify: `src/App.tsx`
- Modify: `src/components/ReviewPanel.tsx`
- Modify: `src/components/reviewPanel.css`
- Test: `tests/components/AnnotationRail.test.tsx`
- Test: `e2e/comments.spec.ts`

**Interfaces:**
- Consumes: Task 1's `AnnotationTarget` and `subscribeAnnotationOpen`; current `ViewState`; `resolveComment` and `FeedbackShape` update semantics.
- Produces: `AnnotationRail` with `target`, `editor`, `onClose`, `onResolve`, `onRestore`; `App` owns `annotationTarget` and `viewBeforeAnnotation`.

- [ ] **Step 1: Write failing component and E2E tests**

```tsx
test('card target lists its open comments and renders no reply input', () => {
  const tree = create(<AnnotationRail target={{ kind: 'card', cardId: 'shape:card', commentId: 'c1' }} editor={editor as any} onClose={() => {}} />)
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-rail' })).toHaveLength(1)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
})
```

```ts
test('closing an annotation rail restores split view', async ({ page }) => {
  await page.getByTestId('draft-open').click()
  await page.getByTestId('annotation-marker').click()
  await expect(page.getByTestId('annotation-rail')).toBeVisible()
  await page.getByRole('button', { name: 'Close annotation' }).click()
  await expect(page.getByTestId('draft-divider')).toBeVisible()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/components/AnnotationRail.test.tsx && npm run e2e -- e2e/comments.spec.ts`

Expected: FAIL because the rail component and controller do not exist.

- [ ] **Step 3: Add the App-owned rail controller and component**

```ts
type AnnotationTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

const [annotationTarget, setAnnotationTarget] = useState<AnnotationTarget | null>(null)
const viewBeforeAnnotation = useRef<ViewState | null>(null)
const openAnnotation = (target: AnnotationTarget) => {
  if (!annotationTarget) viewBeforeAnnotation.current = view
  setAnnotationTarget(target)
}
const closeAnnotation = () => {
  setAnnotationTarget(null)
  if (viewBeforeAnnotation.current) changeView(viewBeforeAnnotation.current)
  viewBeforeAnnotation.current = null
}
```

Subscribe to `subscribeAnnotationOpen(openAnnotation)` in an App effect. When
the rail is open, render it as the right-side pane in place of `DraftPane` and
force the **visual** stage into canvas-plus-right-pane layout, while leaving
`view` itself untouched until `closeAnnotation` restores it. Do not modify
tldraw shape positions, page coordinates or camera in either path.
For card targets, list all unresolved comments and resolve by calling the
existing `resolveComment` update; for feedback, set `resolved: true`. Review
home's resolved item opens the rail first, and restore toggles `resolved: false`
without editing text.

- [ ] **Step 4: Run full annotation verification**

Run: `npm test -- tests/model/annotations.test.ts tests/components/AnnotationRail.test.tsx && npm run typecheck && npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts`

Expected: PASS; only one rail exists, no human authoring controls appear, close
returns to the recorded view, and resolved feedback can restore from Review
home.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/AnnotationRail.tsx src/components/annotationRail.css src/components/ReviewPanel.tsx src/components/reviewPanel.css tests/components/AnnotationRail.test.tsx e2e/comments.spec.ts
git commit -m "feat(annotations): add immutable inspection rail"
```
