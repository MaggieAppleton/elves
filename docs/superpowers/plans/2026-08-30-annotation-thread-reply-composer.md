# Annotation Thread Reply Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide annotation reply composers until a user deliberately opens one, then offer an autosizing, manually resizable editor with a clear send action.

**Architecture:** `AnnotationThread` already powers canvas popovers and the gallery, so it owns disclosure and sizing state. An explicit resize grip replaces the native textarea handle, preventing a collision with Send. Consumer props remain unchanged.

**Tech Stack:** React 18, TypeScript, `@phosphor-icons/react`, CSS custom properties, Vitest/react-test-renderer.

---

## File structure

- `src/components/AnnotationThread.tsx` — disclosure, focus, autosize, per-instance resize state, and Reply icon.
- `src/components/annotationThread.css` — trigger, revealed composer, explicit resize grip, and 8px send inset.
- `tests/components/AnnotationThread.test.ts` — behavioral and CSS contracts.
- `tests/components/AnnotationPopoverLayer.test.ts` — foreground consumer opens a composer before editing.
- `tests/components/CommentStatesGallery.test.ts` — gallery mirrors the shared collapsed thread.

### Task 1: Write failing shared-composer tests

**Files:**
- Modify: `tests/components/AnnotationThread.test.ts`
- Modify: `tests/components/AnnotationPopoverLayer.test.ts:117-119`
- Modify: `tests/components/CommentStatesGallery.test.ts:45-61`

- [ ] **Step 1: Make an open thread require a Reply click before rendering the editor.**

```ts
expect(tree.root.findAllByType('textarea')).toHaveLength(0)
const reply = tree.root.findByProps({ className: 'elves-annotation-thread__reply-trigger' })
expect(reply.props['aria-label']).toBe('Reply to annotation')
expect(reply.findAllByType('svg')).toHaveLength(1)
act(() => reply.props.onClick())
expect(tree.root.findByType('textarea').props.autoFocus).toBe(true)
```

- [ ] **Step 2: Open the composer before every existing draft or send assertion.**

```ts
const openComposer = (tree: ReactTestRenderer, index = 0) => {
  act(() => tree.root
    .findAllByProps({ className: 'elves-annotation-thread__reply-trigger' })[index]
    .props.onClick())
}
```

Use the helper in draft, running, simultaneous-thread, and foreground-popover tests. In the gallery test, assert a trigger exists, click it, then assert one textarea.

- [ ] **Step 3: Cover send/reset, disabled trigger, and the resize grip.**

```ts
act(() => textarea.props.onChange({ target: { value: 'A considered reply' } }))
act(() => tree.root.findByProps({ className: 'elves-annotation-thread__reply' })
  .props.onSubmit({ preventDefault: vi.fn() }))
expect(onReply).toHaveBeenCalledWith('A considered reply')
expect(tree.root.findAllByType('textarea')).toHaveLength(0)

const grip = tree.root.findByProps({ className: 'elves-annotation-thread__reply-resize' })
expect(grip.props['aria-label']).toBe('Resize reply editor')
expect(grip.props['aria-orientation']).toBe('horizontal')
```

Assert locked and running triggers are disabled. Extend CSS checks for `resize: none`, the grip selector, `right: 8px`, `bottom: 8px`, and 43px right text padding.

- [ ] **Step 4: Run focused tests to verify failure.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/components/CommentStatesGallery.test.ts`

Expected: FAIL because trigger, disclosure, and grip are not implemented.

### Task 2: Implement disclosure, autosize, and manual sizing

**Files:**
- Modify: `src/components/AnnotationThread.tsx:1-121`

- [ ] **Step 1: Add local disclosure state and a Phosphor Reply trigger.**

```tsx
const REPLY_MIN_HEIGHT = 76
const [composerOpen, setComposerOpen] = useState(false)
const [replyMinimumHeight, setReplyMinimumHeight] = useState(REPLY_MIN_HEIGHT)
const replyInputRef = useRef<HTMLTextAreaElement>(null)

{!preview && onReply && !composerOpen && <button
  type="button"
  className="elves-annotation-thread__reply-trigger"
  aria-label="Reply to annotation"
  disabled={disabled || running}
  onClick={() => setComposerOpen(true)}
><ArrowBendUpLeft aria-hidden="true" size={15} weight="bold" /></button>}
```

Import `ArrowBendUpLeft` and `useLayoutEffect`. Render the existing form only when `composerOpen`; give the textarea `autoFocus` and `ref={replyInputRef}`.

- [ ] **Step 2: Grow the textarea to its content while preserving the manual minimum.**

```ts
useLayoutEffect(() => {
  const input = replyInputRef.current
  if (!composerOpen || !input) return
  input.style.height = 'auto'
  input.style.height = `${Math.max(input.scrollHeight, replyMinimumHeight)}px`
}, [composerOpen, reply, replyMinimumHeight])
```

Use 76px as the baseline. After the existing valid-send guards, reset the draft and minimum, collapse the composer, then invoke `onReply(text)`:

```ts
sending.current = true
setReply('')
setReplyMinimumHeight(REPLY_MIN_HEIGHT)
setComposerOpen(false)
onReply(text)
```

- [ ] **Step 3: Add an explicit keyboard-accessible resize grip.**

```tsx
<button type="button" className="elves-annotation-thread__reply-resize"
  aria-label="Resize reply editor" aria-orientation="horizontal"
  disabled={disabled || running} onPointerDown={beginReplyResize}
  onPointerMove={resizeReply} onPointerUp={endReplyResize}
  onPointerCancel={endReplyResize} onKeyDown={resizeReplyWithKeyboard} />
```

Store `{ pointerId, startY, startHeight }` in a ref on pointer-down and capture that pointer. On matching pointer-move, set `Math.max(REPLY_MIN_HEIGHT, startHeight + event.clientY - startY)`; clear the ref on pointer-up/cancel. Up and Down prevent default and change the same minimum by 8px.

- [ ] **Step 4: Run focused tests.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/components/CommentStatesGallery.test.ts`

Expected: PASS.

### Task 3: Style the lower-right controls without overlap

**Files:**
- Modify: `src/components/annotationThread.css:30-38`

- [ ] **Step 1: Add the compact circular trigger and shared control states.**

```css
.elves-annotation-thread__reply-trigger {
  align-self: flex-end; display: inline-grid; place-items: center;
  width: 28px; height: 28px; padding: 0;
  border: 1px solid var(--elves-border-strong); border-radius: 50%;
  background: var(--elves-surface); color: var(--elves-ink-soft); cursor: pointer;
}
```

Add this selector to the existing hover, disabled, and focus-visible thread-control rules.

- [ ] **Step 2: Disable native resizing while retaining send’s exact placement.**

```css
.elves-annotation-thread__reply textarea {
  min-height: 76px; padding: 9px 43px 9px 10px; resize: none;
}
.elves-annotation-thread__send { right: 8px; bottom: 8px; }
```

- [ ] **Step 3: Put the grip just outside the textarea’s bottom-right text-safe lane.**

```css
.elves-annotation-thread__reply-resize {
  position: absolute; right: -4px; bottom: -4px; width: 14px; height: 14px;
  padding: 0; border: 0;
  background: repeating-linear-gradient(135deg, transparent 0 3px, var(--elves-ink-faint) 3px 4px);
  cursor: ns-resize;
}
```

Add visible focus and disabled rules. This must not cover the 8px-inset Send button or user text.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/components/CommentStatesGallery.test.ts && npm run typecheck`

Expected: PASS and TypeScript exits 0.

### Task 4: Full verification and scoped stacked commit

**Files:**
- Modify: `src/components/AnnotationThread.tsx`
- Modify: `src/components/annotationThread.css`
- Modify: `tests/components/AnnotationThread.test.ts`
- Modify: `tests/components/AnnotationPopoverLayer.test.ts`
- Modify: `tests/components/CommentStatesGallery.test.ts`

- [ ] **Step 1: Run full verification.**

Run: `npm test && npm run typecheck && git diff --check`

Expected: full test suite passes, TypeScript exits 0, and whitespace check is empty.

- [ ] **Step 2: Confirm the commit avoids unrelated work.**

Run: `git status --short && git diff -- src/components/AnnotationThread.tsx src/components/annotationThread.css tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/components/CommentStatesGallery.test.ts`

Expected: retain the user’s unrelated `package*.json`, `src/main.tsx`, gallery source/style, and other untracked plan/spec files.

- [ ] **Step 3: Commit only the scoped implementation and tests.**

```bash
git add src/components/AnnotationThread.tsx src/components/annotationThread.css tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts tests/components/CommentStatesGallery.test.ts
git commit -m "Polish annotation reply composer"
```

Expected: one stacked-branch commit containing shared composer behavior, visual treatment, and coverage.
