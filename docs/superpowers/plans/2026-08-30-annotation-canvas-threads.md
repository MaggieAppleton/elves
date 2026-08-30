# Annotation Canvas Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single annotation inspector and archival resolved stack with readable hover previews and multiple session-only, anchored, interactive annotation threads on the canvas.

**Architecture:** Integrate PR #154's `InFrontOfTheCanvas` groundwork, then evolve its foreground layer into a renderer for an ordered session-only collection of open targets. Pins remain shape-local, while previews and open threads are rendered in the foreground layer and positioned beside their live pin with pure viewport-aware geometry. The existing durable message, streaming, retry, changeset, and resolve paths remain authoritative and keyed per target.

**Tech Stack:** TypeScript, React 18, tldraw `InFrontOfTheCanvas`/ `useValue`, CSS, Vitest/react-test-renderer, Playwright, Express annotation-run API.

---

## File structure

- `src/client/annotationSelection.ts`: session-only ordered open-target and temporary hover-target store, promotion/dismissal events, resolve events, and existing per-target reply presentation events. Nothing here is serialised.
- `src/client/annotationPlacement.ts`: pure viewport-aware anchor placement used by hover previews and open threads.
- `src/components/AnnotationPopoverLayer.tsx`: PR #154's foreground component, expanded to render one temporary read-only preview plus every open interactive thread.
- `src/components/AnnotationThread.tsx`: shared preview/open conversation surface and compact keyboard-focusable pin; preview mode has no controls, open mode has reply/retry/resolve/close controls.
- `src/components/annotationThread.css`: pin, layer, preview, open-thread, focus, and pointer-event styles.
- `src/App.tsx`: owns durable reply/stream state and resolve behavior, publishes per-target transient state, installs the foreground layer, and no longer changes view state when a thread opens.
- `src/shapes/CardShapeUtil.tsx`, `src/shapes/FeedbackShapeUtil.tsx`, `src/shapes/card.css`, `src/shapes/feedback.css`: render only compact unresolved pins and pass stable targets.
- `src/components/ReviewPanel.tsx`, `src/components/reviewPanel.css`: retain review-pass controls while removing the resolved-annotation stack and reopen callback.
- Delete `src/components/AnnotationRail.tsx`, `src/components/annotationRail.css`, and `tests/components/AnnotationRail.test.ts`; the rail and forced split presentation no longer exist.
- `tests/client/annotationSelection.test.ts`, `tests/client/annotationPlacement.test.ts`, `tests/components/AnnotationThread.test.ts`, `tests/components/AnnotationPopoverLayer.test.ts`, and `e2e/comments.spec.ts`: session-store, geometry, component, and browser coverage.
- Existing `src/model/types.ts`, `src/model/comments.ts`, `src/model/feedback.ts`, `src/model/changeset.ts`, `src/client/annotationThread.ts`, `server/app.ts`, and their tests remain the durable message/run contract; do not duplicate that protocol in the UI slice.

### Task 1: Integrate the approved foreground-layer groundwork

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/client/annotationSelection.ts`
- Create: `src/components/AnnotationPopoverLayer.tsx`
- Modify: `src/components/AnnotationThread.tsx`
- Modify: `src/components/annotationThread.css`
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/shapes/FeedbackShapeUtil.tsx`
- Modify: `e2e/comments.spec.ts`
- Modify: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Confirm the base and PR commit before changing code**

Run:
~~~bash
git status --short --branch
git merge-base --is-ancestor ed4613f3e8aa8a23832a38efd135cb3e047b8a78 HEAD; printf 'ancestor=%s\n' "$?"
~~~

Expected: the branch is `design/annotation-canvas-threads`, the working tree is clean, and `ancestor=1` because PR #154 is in the separate `fix/annotation-hover-layering` worktree.

- [ ] **Step 2: Bring PR #154 into this branch as one focused commit**

Run:
~~~bash
git cherry-pick ed4613f3e8aa8a23832a38efd135cb3e047b8a78
~~~

Expected: a new commit adds `AnnotationPopoverLayer`, popover timer/state helpers, `InFrontOfTheCanvas` registration, and front-layer E2E coverage. Do not reimplement those changes in a second layer before this commit is present.

- [ ] **Step 3: Verify the integrated groundwork**

Run:
~~~bash
npx vitest run tests/components/AnnotationThread.test.ts tests/client/annotationSelection.test.ts
npm run typecheck
~~~

Expected: focused tests and typecheck pass; the current behavior still has one foreground hover popover and one inspector target, which is the intentional pre-redesign state.

- [ ] **Step 4: Keep the integration commit separate**

Run:
~~~bash
git show --stat --oneline HEAD
git status --short
~~~

Expected: only PR #154's files are in the cherry-pick commit and the working tree is clean.

### Task 2: Define ordered session targets and viewport placement with tests first

**Files:**
- Modify: `src/client/annotationSelection.ts` (`AnnotationTarget`, open/hover store, subscriptions)
- Create: `src/client/annotationPlacement.ts` (`placeAnnotationThread`, `clamp`)
- Test: `tests/client/annotationSelection.test.ts`
- Create: `tests/client/annotationPlacement.test.ts`

- [ ] **Step 1: Write failing store tests**

Extend `tests/client/annotationSelection.test.ts`:
~~~tsx
import {
  annotationOpenTargets, annotationHoverTarget, clearAnnotationPresentations,
  closeAnnotationThread, openAnnotationThread, promoteAnnotationThread,
  setAnnotationHover,
} from '../../src/client/annotationSelection'

const a = { kind: 'card' as const, cardId: 'shape:a', commentId: 'comment:a' }
const b = { kind: 'feedback' as const, feedbackId: 'shape:b' }

test('open targets are session-only, independent, and ordered by engagement', () => {
  clearAnnotationPresentations()
  openAnnotationThread(a)
  openAnnotationThread(b)
  expect(annotationOpenTargets()).toEqual([a, b])
  promoteAnnotationThread(a)
  expect(annotationOpenTargets()).toEqual([b, a])
  closeAnnotationThread(a)
  expect(annotationOpenTargets()).toEqual([b])
})

test('hover target is temporary and separate from open targets', () => {
  clearAnnotationPresentations()
  setAnnotationHover(a)
  expect(annotationHoverTarget()).toEqual(a)
  expect(annotationOpenTargets()).toEqual([])
  setAnnotationHover(null)
  expect(annotationHoverTarget()).toBeNull()
})
~~~

- [ ] **Step 2: Run the store tests to verify red state**

Run: `npx vitest run tests/client/annotationSelection.test.ts`

Expected: FAIL because the current module has no open-target collection, promotion, or hover-target API.

- [ ] **Step 3: Implement the session-only ordered target store**

In `src/client/annotationSelection.ts`, retain `AnnotationTarget`, reply/retry, and per-target presentation APIs, then add:
~~~ts
type AnnotationTargetListener = () => void
const openTargets = new Map<string, AnnotationTarget>()
const targetListeners = new Set<AnnotationTargetListener>()
let hoverTarget: AnnotationTarget | null = null

function emitTargets() { targetListeners.forEach((listener) => listener()) }

export function annotationOpenTargets(): AnnotationTarget[] { return Array.from(openTargets.values()) }
export function annotationHoverTarget(): AnnotationTarget | null { return hoverTarget }
export function subscribeAnnotationTargets(listener: AnnotationTargetListener): () => void {
  targetListeners.add(listener)
  return () => targetListeners.delete(listener)
}
export function openAnnotationThread(target: AnnotationTarget): void {
  const key = annotationTargetKey(target)
  if (openTargets.has(key)) return
  openTargets.set(key, target)
  emitTargets()
}
export function promoteAnnotationThread(target: AnnotationTarget): void {
  const key = annotationTargetKey(target)
  const current = openTargets.get(key)
  if (!current) return
  openTargets.delete(key)
  openTargets.set(key, current)
  emitTargets()
}
export function closeAnnotationThread(target: AnnotationTarget): void {
  if (!openTargets.delete(annotationTargetKey(target))) return
  emitTargets()
}
export function setAnnotationHover(target: AnnotationTarget | null): void {
  hoverTarget = target && openTargets.has(annotationTargetKey(target)) ? null : target
  emitTargets()
}
export function clearAnnotationPresentations(): void {
  openTargets.clear()
  hoverTarget = null
  clearAnnotationPopover()
  clearAnnotationThreadPresentations()
  emitTargets()
}
~~~

Preserve the PR's 100ms delayed hover dismissal, but make it clear only the matching hover target. `requestAnnotationOpen` should add the target to the open collection before notifying any remaining legacy listeners. This module is session state only; it must never be included in a tldraw shape or canvas snapshot.

- [ ] **Step 4: Write failing placement tests**

Create `tests/client/annotationPlacement.test.ts`:
~~~ts
import { expect, test } from 'vitest'
import { placeAnnotationThread } from '../../src/client/annotationPlacement'

const viewport = { left: 0, top: 0, width: 800, height: 600 }
const thread = { width: 300, height: 180 }

test('prefers the space beside the pin', () => {
  expect(placeAnnotationThread({ left: 500, top: 220, width: 28, height: 28 }, thread, viewport))
    .toEqual({ left: 188, top: 220, side: 'left' })
})

test('flips when the preferred side has insufficient room', () => {
  expect(placeAnnotationThread({ left: 30, top: 220, width: 28, height: 28 }, thread, viewport).side)
    .toBe('right')
})

test('clamps an edge anchor and an over-sized panel into the viewport', () => {
  expect(placeAnnotationThread({ left: 760, top: 560, width: 28, height: 28 }, { width: 900, height: 700 }, viewport))
    .toMatchObject({ left: 0, top: 0 })
})
~~~

- [ ] **Step 5: Run placement tests to verify red state**

Run: `npx vitest run tests/client/annotationPlacement.test.ts`

Expected: FAIL because `src/client/annotationPlacement.ts` does not exist.

- [ ] **Step 6: Implement pure viewport-aware placement**

Create `src/client/annotationPlacement.ts`:
~~~ts
export interface AnnotationRect { left: number; top: number; width: number; height: number }
export interface AnnotationViewport { left: number; top: number; width: number; height: number }
export interface AnnotationPlacement { left: number; top: number; side: 'left' | 'right' }

const GAP = 12
const EDGE = 8

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

export function placeAnnotationThread(
  anchor: AnnotationRect,
  thread: Pick<AnnotationRect, 'width' | 'height'>,
  viewport: AnnotationViewport,
): AnnotationPlacement {
  const normalLeft = anchor.left - thread.width - GAP
  const rightLeft = anchor.left + anchor.width + GAP
  const leftFits = normalLeft >= viewport.left + EDGE
  const side = leftFits ? 'left' : 'right'
  const preferredLeft = leftFits ? normalLeft : rightLeft
  return {
    side,
    left: clamp(preferredLeft, viewport.left + EDGE, viewport.left + viewport.width - thread.width - EDGE),
    top: clamp(anchor.top, viewport.top + EDGE, viewport.top + viewport.height - thread.height - EDGE),
  }
}
~~~

The function must use layer-relative rectangles, prefer the left side, flip to the right when needed, and clamp both axes even when a panel is larger than the stage.

- [ ] **Step 7: Run and commit this slice**

Run:
~~~bash
npx vitest run tests/client/annotationSelection.test.ts tests/client/annotationPlacement.test.ts
git add src/client/annotationSelection.ts src/client/annotationPlacement.ts tests/client/annotationSelection.test.ts tests/client/annotationPlacement.test.ts
git commit -m "feat(annotations): add session thread targets and placement"
~~~

Expected: focused tests pass and this commit contains no React, tldraw, or persisted-model changes.

### Task 3: Make pins and the shared thread surface obey preview/open semantics

**Files:**
- Modify: `src/components/AnnotationThread.tsx` (`AnnotationThread`, `AnnotationPin`)
- Modify: `src/components/annotationThread.css`
- Modify: `src/shapes/CardShapeUtil.tsx`
- Modify: `src/shapes/FeedbackShapeUtil.tsx`
- Modify: `src/shapes/card.css`
- Modify: `src/shapes/feedback.css`
- Modify: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Write failing preview/open tests**

Add to `tests/components/AnnotationThread.test.ts`:
~~~tsx
test('preview mode renders every message but no interactive control', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: 'structure', text: 'Initial finding', resolved: false, author: 'claude',
      messages: [
        { id: 'm1', author: 'claude', text: 'Initial finding', createdAt: '2026-08-30T09:00:00Z' },
        { id: 'm2', author: 'user', text: 'What would fix it?', createdAt: '2026-08-30T09:01:00Z' },
      ],
    },
    mode: 'preview',
  }))
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByType('button')).toHaveLength(0)
})

test('open mode exposes reply, retry, resolve, and close actions', () => {
  const onClose = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onClose, onResolve: vi.fn(), onReply: vi.fn(),
    error: 'The reply stopped.', onRetry: vi.fn(),
  }))
  expect(tree.root.findByType('textarea')).toBeTruthy()
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props['aria-label'])
    .toBe('Close annotation thread')
  expect(tree.root.findByText('Retry')).toBeTruthy()
  tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props.onClick()
  expect(onClose).toHaveBeenCalledOnce()
})
~~~

- [ ] **Step 2: Run component tests to verify red state**

Run: `npx vitest run tests/components/AnnotationThread.test.ts`

Expected: FAIL because the current component accepts only `popover`/`rail`, renders resolve in every mode, and renders the conversation inside each pin.

- [ ] **Step 3: Implement explicit preview/open rendering**

Change `AnnotationThreadProps.mode` to `'preview' | 'open'`, add `onClose?: () => void`, and gate every interactive element:
~~~tsx
const preview = mode === 'preview'
return (
  <article className={`elves-annotation-thread elves-annotation-thread--${mode}`} data-testid="annotation-thread">
    <div className="elves-annotation-thread__meta">{type} {agentName(comment.author)}</div>
    <div className="elves-annotation-thread__messages">
    {messages.map((message) => <p key={message.id} className="elves-annotation-thread__message" data-author={message.author}><span className="elves-annotation-thread__message-author">{agentName(message.author)}</span><span className="elves-annotation-thread__text">{message.text}</span></p>)}
      {streamingText && <p className="elves-annotation-thread__message" data-author="claude"><span className="elves-annotation-thread__text">{streamingText}</span></p>}
    </div>
    {!preview && onReply && <form className="elves-annotation-thread__reply" onSubmit={send}><textarea aria-label="Reply to annotation" value={reply} onChange={(event) => setReply(event.target.value)} /><button type="submit" disabled={!reply.trim() || running}>Send reply</button></form>}
    {!preview && error && <div className="elves-annotation-thread__error" role="alert">{error}<button type="button" onClick={onRetry}>Retry</button></div>}
    {!preview && onResolve && <button type="button" className="elves-annotation-thread__resolve" onClick={onResolve}>{actionLabel}</button>}
    {!preview && onClose && <button type="button" className="elves-annotation-thread__close" aria-label="Close annotation thread" onClick={onClose}>×</button>}
  </article>
)
~~~

The implementation must use the existing `threadMessages`, preserve per-target `running`/`streamingText`/`error` and retry behavior, and not instantiate a textarea or button at all in preview mode. Render each message from the existing `id`, `author`, and `text` fields; do not introduce a second message source.

- [ ] **Step 4: Move pin hover/focus into the session store**

Remove the inline `AnnotationThread` from `AnnotationPin`. Use the existing target key and delayed hide helper:
~~~tsx
const show = () => target && setAnnotationHover(target)
const hide = () => target && dismissAnnotationPopoverSoon(target)
const open = (event: MouseEvent) => {
  stopEvent(event)
  if (target) {
    openAnnotationThread(target)
    promoteAnnotationThread(target)
  }
  onOpen?.()
}
return (
  <div className="elves-annotation-pin-wrap"
    onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
    <button type="button" className="elves-annotation-pin"
      data-testid="annotation-pin"
      data-annotation-target={target ? annotationTargetKey(target) : undefined}
      onClick={open}>
      <span aria-hidden="true">{pinGlyph(token.icon)}</span>
    </button>
  </div>
)
~~~

Keep inverse zoom sizing, the stable 28px button, accessible gist/type label, and pointer-down/click propagation prevention. Hover/focus never opens an interactive thread; click opens/promotes the target.

- [ ] **Step 5: Update shape utilities to pass stable targets only**

In `CardShapeUtil.component`, retain `visibleComments(shape.props.comments)` and `cardAnnotationPins(comments)`, then pass:
~~~tsx
<AnnotationPin
  key={comment.id}
  comment={comment}
  offsetY={offsetY}
  zoom={zoom}
  target={{ kind: 'card', cardId: shape.id, commentId: comment.id }}
  onOpen={() => requestAnnotationOpen({ kind: 'card', cardId: shape.id, commentId: comment.id })}
/>
~~~

In `FeedbackShapeUtil.component`, retain its resolved early return and pass the feedback target. Remove attribution/reply/retry props from both shape-local calls; the foreground layer resolves live content and transient state.

- [ ] **Step 6: Replace inline-popover CSS with foreground-safe styles**

Delete descendant hover/visibility rules for the old inline panel and add:
~~~css
.elves-annotation-popover-layer {
  position: absolute;
  inset: 0;
  z-index: calc(var(--layer-canvas-overlays) + 1);
  pointer-events: none;
}
.elves-annotation-popover-layer > * { pointer-events: all; }
.elves-annotation-preview,
.elves-annotation-thread--open {
  position: absolute;
  width: min(300px, 72vw);
}
.elves-annotation-thread--preview { box-shadow: var(--elves-shadow-md); }
.elves-annotation-thread__close {
  position: absolute;
  top: 8px;
  right: 8px;
}
~~~

The transparent layer must not intercept panning or selection; only a rendered preview/open panel is pointer-enabled.

- [ ] **Step 7: Run component/type checks and commit**

Run:
~~~bash
npx vitest run tests/components/AnnotationThread.test.ts tests/model/annotationPins.test.ts
npm run typecheck
git add src/components/AnnotationThread.tsx src/components/annotationThread.css src/shapes/CardShapeUtil.tsx src/shapes/FeedbackShapeUtil.tsx src/shapes/card.css src/shapes/feedback.css tests/components/AnnotationThread.test.ts
git commit -m "feat(annotations): separate read-only previews from open threads"
~~~

Expected: preview tests prove there are no controls; open tests prove reply/retry/resolve/close exist; typecheck passes.

### Task 4: Render every open thread in the foreground layer with live anchors

**Files:**
- Modify: `src/components/AnnotationPopoverLayer.tsx` (`AnnotationPopoverLayer`, `contentForTarget`)
- Modify: `src/client/annotationSelection.ts` (resolve/close event bridges)
- Modify: `src/components/annotationThread.css`
- Test: `tests/components/AnnotationThread.test.ts`
- Create: `tests/components/AnnotationPopoverLayer.test.ts`

- [ ] **Step 1: Write failing foreground-entry tests**

Export a small pure helper from the layer and test. Define its complete contract before the tests:
~~~ts
export type ForegroundEntry = { target: AnnotationTarget; mode: 'preview' | 'open'; zIndex: number }
export function foregroundEntries(open: AnnotationTarget[], hovered: AnnotationTarget | null = null): ForegroundEntry[] {
  const entries: ForegroundEntry[] = []
  if (hovered && !open.some((target) => annotationTargetKey(target) === annotationTargetKey(hovered))) {
    entries.push({ target: hovered, mode: 'preview', zIndex: open.length + 1 })
  }
  open.forEach((target, index) => entries.push({ target, mode: 'open', zIndex: index + 1 }))
  return entries
}
~~~

Test it:
~~~tsx
test('renders all open targets with increasing foreground order', () => {
  const targets = [
    { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' },
    { kind: 'feedback' as const, feedbackId: 'shape:b' },
  ]
  expect(foregroundEntries(targets).map((entry) => entry.zIndex)).toEqual([1, 2])
})

test('hover preview is not duplicated when its target is already open', () => {
  const target = { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' }
  expect(foregroundEntries([target], target)).toHaveLength(1)
  expect(foregroundEntries([], target)[0].mode).toBe('preview')
})
~~~

- [ ] **Step 2: Run overlay tests to verify red state**

Run: `npx vitest run tests/components/AnnotationPopoverLayer.test.ts`

Expected: FAIL because the integrated PR layer supports one `annotationPopover()`, not a collection or separate preview entries.

- [ ] **Step 3: Add resolve, close, and pruning bridges**

In `annotationSelection.ts`, add:
~~~ts
type AnnotationActionListener = (target: AnnotationTarget) => void
const resolveListeners = new Set<AnnotationActionListener>()
export function subscribeAnnotationResolve(listener: AnnotationActionListener): () => void {
  resolveListeners.add(listener)
  return () => resolveListeners.delete(listener)
}
export function requestAnnotationResolve(target: AnnotationTarget): void {
  resolveListeners.forEach((listener) => listener(target))
}
export function requestAnnotationClose(target: AnnotationTarget): void {
  closeAnnotationThread(target)
}
export function pruneAnnotationThreads(isOpenTarget: (target: AnnotationTarget) => boolean): void {
  let changed = false
  for (const [key, target] of openTargets) {
    if (!isOpenTarget(target)) { openTargets.delete(key); changed = true }
  }
  if (changed) emitTargets()
}
~~~

A missing/deleted card, missing comment, missing feedback shape, or resolved annotation must remove only its target. Pruning must never mutate the canvas record or another target.

- [ ] **Step 4: Replace the one-target PR layer with collection rendering**

Keep `contentForTarget(target, shape)` as the live source of annotation content, then use:
~~~tsx
const openTargets = annotationOpenTargets()
const hovered = annotationHoverTarget()
const entries = hovered && !openTargets.some((target) =>
  annotationTargetKey(target) === annotationTargetKey(hovered))
  ? [{ target: hovered, mode: 'preview' as const }]
  : []
openTargets.forEach((target, index) => entries.push({
  target, mode: 'open' as const, zIndex: index + 1,
}))
~~~

Define `AnnotationForegroundItem({ target, mode, zIndex, editor })` in the same file. Its body reads the target shape with `useValue`, reads `editor.getCamera()` with `useValue`, locates the matching `data-annotation-target` pin, measures itself with `ResizeObserver` and `requestAnimationFrame`, converts rectangles relative to `editor.getContainer().getBoundingClientRect()`, and calls `placeAnnotationThread`. Render `AnnotationThread mode="preview"` with no callbacks for previews. Render `mode="open"` with the matching presentation and `requestAnnotationReply`, `requestAnnotationRetry`, `requestAnnotationResolve`, and `requestAnnotationClose` callbacks. Set a monotonic z-index so the last promoted target is above earlier targets.

The outer layer has `pointer-events:none`; each actual panel has `pointer-events:all`. Pointer/focus handlers on pin and preview use the same delayed hide timer, while focus within an open thread does not close it. Moving an anchor outside the viewport keeps the target/anchor relationship and clamps the panel rather than detaching it.

- [ ] **Step 5: Add component-level isolation assertions**

Extend component tests:
~~~tsx
test('closing one open target leaves the other target open', () => {
  const a = { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' }
  const b = { kind: 'card' as const, cardId: 'shape:b', commentId: 'b' }
  openAnnotationThread(a)
  openAnnotationThread(b)
  requestAnnotationClose(a)
  expect(annotationOpenTargets()).toEqual([b])
})

test('preview has no reply, retry, resolve, or close controls', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'a', type: null, text: 'Read this', resolved: false, author: 'claude' },
    mode: 'preview',
  }))
  expect(tree.root.findAllByType('button')).toHaveLength(0)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
})
~~~

- [ ] **Step 6: Run overlay/component checks and commit**

Run:
~~~bash
npx vitest run tests/components/AnnotationPopoverLayer.test.ts tests/components/AnnotationThread.test.ts tests/client/annotationSelection.test.ts
npm run typecheck
git add src/components/AnnotationPopoverLayer.tsx src/client/annotationSelection.ts src/components/annotationThread.css tests/components/AnnotationPopoverLayer.test.ts tests/components/AnnotationThread.test.ts
git commit -m "feat(annotations): render multiple anchored foreground threads"
~~~

Expected: all open targets render independently, promotion affects only order, missing targets prune safely, and typecheck passes.

### Task 5: Remove the rail, forced split transition, and resolved stack

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ReviewPanel.tsx`
- Modify: `src/components/reviewPanel.css`
- Delete: `src/components/AnnotationRail.tsx`
- Delete: `src/components/annotationRail.css`
- Delete: `tests/components/AnnotationRail.test.ts`
- Create: `tests/components/ReviewPanel.test.ts`

- [ ] **Step 1: Add failing removal assertions**

Add this ReviewPanel assertion:
~~~tsx
test('review panel has no resolved annotation stack', () => {
  const tree = create(createElement(ReviewPanel, {
    projectId: 'essay', editor: null, reviews: [], disabled: false,
    onSummon: vi.fn(), onDismiss: vi.fn(), onRetry: vi.fn(),
  }))
  expect(tree.root.findAllByProps({ 'data-feedback-stack': true })).toHaveLength(0)
})
~~~

Add an App/browser harness assertion that opening a pin leaves `data-view` and the draft divider unchanged; the current `visualView = annotationTarget ? 'split' : view` and rail branch must fail that assertion.

- [ ] **Step 2: Run removal tests to verify red state**

Run: `npx vitest run tests/components/ReviewPanel.test.ts tests/components/AnnotationRail.test.ts`

Expected: the new no-stack/view assertion fails while the old rail tests pass, identifying the exact removal slice.

- [ ] **Step 3: Convert App to normal view state plus foreground registration**

In `src/App.tsx`, register the PR/evolved layer:
~~~tsx
const components = {
  SelectionForeground: CardSelectionForeground,
  OnTheCanvas: SnapHighlight,
  InFrontOfTheCanvas: AnnotationPopoverLayer,
}
~~~

Delete `annotationTarget`, `viewBeforeAnnotation`, `annotationProjectId`, `openAnnotation`, `closeAnnotation`, `restoreFeedback`, the `subscribeAnnotationOpen` App effect, and the `visualView` override. Subscribe once to `subscribeAnnotationResolve`; use the following live-editor helper so only the requested record changes:
~~~ts
function resolveAnnotationRecord(editor: Editor, target: AnnotationTarget): void {
  if (target.kind === 'card') {
    const shape = editor.getShape(target.cardId as TLShapeId) as CardShape | undefined
    if (!shape || shape.type !== 'card') return
    editor.updateShape<CardShape>({
      id: shape.id, type: 'card',
      props: { comments: shape.props.comments.map((comment) =>
        comment.id === target.commentId ? { ...comment, resolved: true } : comment) },
    })
    return
  }
  const shape = editor.getShape(target.feedbackId as TLShapeId) as FeedbackShape | undefined
  if (shape?.type === 'feedback') editor.updateShape<FeedbackShape>({
    id: shape.id, type: 'feedback', props: { resolved: true },
  })
}
~~~
The resolve subscription calls `resolveAnnotationRecord(editor, target)` and then closes only that session target. Keep `canvasMutationsLocked` as the mutation guard.

Use `const visualView = view`, render the divider whenever `visualView === 'split'`, and render `DraftPane` unconditionally. Project switch/unmount calls `clearAnnotationPresentations()` before changing/mounting the project, so the next session starts with no open targets and no persisted presentation state.

- [ ] **Step 4: Remove the ReviewPanel stack without touching records**

Delete `resolvedAnnotations`, its `useValue('resolved annotation stack')` call, `onOpenAnnotation`, and the resolved-stack JSX. Keep review pass tallies, summon/dismiss/retry, and unrelated controls. Delete only `.elves-review__resolved-stack`, `.elves-review__resolved-heading`, and `.elves-review__resolved-item` from `reviewPanel.css`.

Do not delete `feedbackIsHidden`, resolved fields, or review counts: records remain durable even though there is no permanent canvas archive UI.

- [ ] **Step 5: Delete obsolete rail files and update imports**

Delete `src/components/AnnotationRail.tsx`, `src/components/annotationRail.css`, and `tests/components/AnnotationRail.test.ts`. Remove stale `AnnotationRail`, `annotation-rail`, `onRestore`, and rail-only `threadState` references. Do not remove the durable client/server thread protocol.

- [ ] **Step 6: Run focused removal/type checks and commit**

Run:
~~~bash
npx vitest run tests/components/ReviewPanel.test.ts tests/client/annotationSelection.test.ts
npm run typecheck
git add src/App.tsx src/components/ReviewPanel.tsx src/components/reviewPanel.css src/client/annotationSelection.ts
git add -u src/components/AnnotationRail.tsx src/components/annotationRail.css tests/components/AnnotationRail.test.ts
git commit -m "refactor(annotations): remove inspector and resolved stack"
~~~

Expected: no rail/inspector symbols remain in App or ReviewPanel, view/split behavior is unchanged by annotation opening, and resolved records remain represented by `resolved`/ `feedbackIsHidden`.

### Task 6: Preserve durable reply/retry/resolve behavior for simultaneous targets

**Files:**
- Modify: `src/App.tsx` (`annotationThreadStates`, `replyToAnnotation`, `startAnnotationRun`, `retryAnnotation`, resolve subscription)
- Modify: `src/client/annotationSelection.ts` (presentation publication)
- Modify: `tests/components/AnnotationThread.test.ts`
- Verify: `src/model/types.ts`, `src/model/comments.ts`, `src/model/feedback.ts`, `src/model/changeset.ts`, `src/client/annotationThread.ts`, `server/app.ts`, `tests/server/api.test.ts`, `tests/server/agentRoutes.test.ts`

- [ ] **Step 1: Add failing per-target isolation test**

~~~tsx
test('simultaneous threads keep reply state isolated', () => {
  const tree = create(createElement('div', {},
    createElement(AnnotationThread, { comment: { id: 'a', type: null, text: 'Finding', resolved: false, author: 'claude' }, mode: 'open', running: true, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn() }),
    createElement(AnnotationThread, { comment: { id: 'b', type: null, text: 'Finding', resolved: false, author: 'claude' }, mode: 'open', running: false, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn() }),
  ))
  const sends = tree.root.findAllByProps({ className: 'elves-annotation-thread__send' })
  expect(sends).toHaveLength(2)
  expect(sends[0].props.disabled).toBe(true)
  expect(sends[1].props.disabled).toBe(false)
})
~~~

- [ ] **Step 2: Run state and durable protocol tests**

Run:
~~~bash
npx vitest run tests/components/AnnotationThread.test.ts tests/client/annotationThread.test.ts tests/server/api.test.ts tests/server/agentRoutes.test.ts
~~~

Expected: the new test is red until each foreground item consumes only its own presentation; existing append-before-run, persisted-message identity, retry, single-flight, and SSE-end tests remain green.

- [ ] **Step 3: Keep App state project-scoped and identity-keyed**

Retain the current contract:
~~~ts
type AnnotationThreadState = {
  key: string
  target: AnnotationThreadTarget
  running: boolean
  streamingText: string
  error: string | null
  messageId: string | null
}
~~~

Keep `annotationKey` scoped by project and card/comment or feedback identity. `replyToAnnotation` persists the user message before `startAnnotationRun`; `retryAnnotation` reuses the saved `messageId` and never appends another user turn. Update/clear only the matching key. An error leaves `error` and `messageId` available to that thread's Retry control. The existing global canvas-transition lock may disable sends, but one target's `running` must never disable another target's controls.

- [ ] **Step 4: Wire resolve versus close semantics**

The resolve listener must update the document and then close just that target:
~~~ts
const unsubscribeResolve = subscribeAnnotationResolve((target) => {
  if (canvasMutationsLocked || !editor) return
  resolveAnnotationRecord(editor, target)
  closeAnnotationThread(target)
})
~~~

The X callback only calls `requestAnnotationClose`; it leaves resolved status, messages, and retry state untouched. Resolving persists status and hides the pin through existing visibility logic.

- [ ] **Step 5: Run durable checks and commit**

Run:
~~~bash
npx vitest run tests/components/AnnotationThread.test.ts tests/client/annotationThread.test.ts tests/server/api.test.ts tests/server/agentRoutes.test.ts tests/model/comments.test.ts tests/model/feedback.test.ts
npm run typecheck
git add src/App.tsx src/client/annotationSelection.ts tests/components/AnnotationThread.test.ts
git commit -m "feat(annotations): isolate reply and resolve state per thread"
~~~

Expected: server tests prove persisted replies, response identity, bounded history, retry idempotency, and per-target single-flight remain unchanged; UI tests prove state isolation.

### Task 7: Replace legacy browser coverage with the approved interaction matrix

**Files:**
- Modify: `e2e/comments.spec.ts`
- Modify: `e2e/reviews.spec.ts`
- Modify: `e2e/draft.spec.ts` only where an assertion assumes annotation-forced split state
- Modify: `tests/components/AnnotationThread.test.ts`
- Modify: `tests/components/AnnotationPopoverLayer.test.ts`

- [ ] **Step 1: Remove deleted-UI tests and add reload baseline**

Delete tests requiring `annotation-rail`, a rail close restoring split, or resolved-stack `Restore annotation`. Add:
~~~ts
test('a fresh session has no open annotation threads', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Session-only thread.' })
  await page.getByTestId('annotation-pin').click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('annotation-thread')).toHaveCount(0)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(1)
})
~~~

- [ ] **Step 2: Add hover/focus read-only and transition coverage**

~~~ts
test('hover and keyboard focus show a complete read-only preview', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'structure', text: 'The complete conversation is readable here.' })
  const pin = page.getByTestId('annotation-pin')
  await pin.hover()
  const preview = page.getByTestId('annotation-preview')
  await expect(preview).toContainText('The complete conversation is readable here.')
  await expect(preview.getByRole('button')).toHaveCount(0)
  await expect(preview.locator('textarea')).toHaveCount(0)
  expect(await preview.evaluate((element) => element.closest('.tl-shape'))).toBeNull()
  await pin.focus()
  await expect(preview).toBeVisible()
})
~~~

Use the existing short hover dismissal window for the pin-to-preview pointer transition; do not add a multi-second wait.

- [ ] **Step 3: Add multiple-thread promotion/close/resolve/prune coverage**

Create two card comments and one floating feedback, then assert:
~~~ts
await expect(page.getByTestId('annotation-pin')).toHaveCount(3)
await page.getByTestId('annotation-pin').nth(0).click()
await page.getByTestId('annotation-pin').nth(1).click()
await expect(page.getByTestId('annotation-thread')).toHaveCount(2)
await page.getByTestId('annotation-pin').nth(0).click()
await page.getByLabel('Close annotation thread').first().click()
await expect(page.getByTestId('annotation-thread')).toHaveCount(1)
~~~

Resolve the remaining thread and assert its pin disappears while the server canvas still contains its `resolved: true` record. Delete its anchor via the existing API/UI helper and assert any other open thread remains. Assert no `data-feedback-stack`, `annotation-rail`, or annotation-created drawer handle appears.

- [ ] **Step 4: Add streaming/failure/retry persistence coverage**

Use the existing stub routes to assert the affected open thread alone shows `Replying…`, interim text, final Claude text, and an enabled textarea. Force one stream to fail, assert an alert and Retry, retry, and poll the persisted canvas for exactly one user message plus one Claude reply whose `inReplyToMessageId` equals that user id.

- [ ] **Step 5: Add pan/zoom/movement/edge/stack coverage**

For an open thread, record pin/panel boxes, pan and zoom with tldraw controls, and move the underlying card. Assert the panel follows its pin and remains within the stage:
~~~ts
const box = await page.getByTestId('annotation-thread').boundingBox()
expect(box).not.toBeNull()
expect(box!.x).toBeGreaterThanOrEqual(0)
expect(box!.y).toBeGreaterThanOrEqual(0)
expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
~~~

Place threads at every viewport edge and over cards, feedback, link previews, and other annotations; assert textarea/reply/retry/resolve/X controls remain clickable and uncovered layer space still permits canvas selection/panning. Define the viewport used by the assertion as `const viewport = page.viewportSize() ?? { width: 1280, height: 720 }`.

- [ ] **Step 6: Run browser tests and commit**

Run:
~~~bash
npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts e2e/draft.spec.ts
git add e2e/comments.spec.ts e2e/reviews.spec.ts e2e/draft.spec.ts tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts
git commit -m "test(annotations): cover canvas thread interactions"
~~~

Expected: hover-to-click has no flicker/premature controls; multiple threads promote independently; reply/retry/resolve/persistence work; pan/zoom/movement and edge placement work; inspector, forced split, resolved stack, and edge handle are absent.

### Task 8: Full verification and handoff

**Files:**
- Verify: all files changed in Tasks 1–7
- Verify: `src/model/types.ts`, `src/model/comments.ts`, `src/model/feedback.ts`, `src/model/changeset.ts`, `src/client/annotationThread.ts`, `server/app.ts`

- [ ] **Step 1: Scan for stale symbols and plan placeholders**

Run:
~~~bash
rg -n "AnnotationRail|annotation-rail|resolved-stack|resolved-item|viewBeforeAnnotation|annotationTarget|Restore annotation|visualView = annotationTarget" src tests e2e || true
~~~

Expected: the command returns no executable references to deleted interfaces.

- [ ] **Step 2: Run focused model/client/component/server/type/build checks**

Run:
~~~bash
npx vitest run tests/model/annotationPins.test.ts tests/model/comments.test.ts tests/model/feedback.test.ts tests/model/changeset.test.ts tests/client/annotationSelection.test.ts tests/client/annotationPlacement.test.ts tests/client/annotationThread.test.ts tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/server/api.test.ts tests/server/agentRoutes.test.ts
npm run typecheck
npm run build:local
~~~

Expected: focused tests pass, typecheck exits 0, and the production build has no unresolved rail/import/symbol errors.

- [ ] **Step 3: Run complete tests and browser suites**

Run:
~~~bash
npm test
npm run e2e -- e2e/comments.spec.ts e2e/reviews.spec.ts e2e/draft.spec.ts e2e/app-canvas-coordinator.spec.ts
~~~

Expected: full Vitest and browser suites pass, or browser output clearly records the known bootstrap blocker (`No projects yet`) without claiming annotation readiness. Do not weaken annotation assertions to hide that blocker.

- [ ] **Step 4: Review the final diff**

Run:
~~~bash
git diff --check
git status --short
git diff --stat HEAD^ HEAD
~~~

Expected: no whitespace errors, only approved canvas-thread files plus the isolated PR #154 integration commit are present, and no durable annotation schema/API change was introduced.

- [ ] **Step 5: Report the implementation handoff**

Report commit hashes, focused/full test outcomes, browser outcome and any bootstrap blocker, plus these decisions: targets are session-only and ordered by engagement; previews are read-only; open threads are stage-level and viewport-clamped; X closes presentation only; resolve persists and closes; pruning never mutates records; durable replies remain keyed by persisted user-message identity.
