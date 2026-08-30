# Annotation Thread Resize-Grip Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the visible manual resize control from shared annotation reply editors while retaining their content-driven autosizing behavior.

**Architecture:** Keep disclosure and Send inside `AnnotationThread`. Delete the manual-resize state, DOM separator, pointer/key handlers, and associated CSS; the existing layout effect sizes the textarea to its `scrollHeight` with the 76px baseline.

**Tech Stack:** React 18, TypeScript, CSS custom properties, Vitest/react-test-renderer.

---

## File structure

- `src/components/AnnotationThread.tsx` — retain autosize and remove manual-resize implementation.
- `src/components/annotationThread.css` — remove the visible resize-grip rules and references.
- `tests/components/AnnotationThread.test.ts` — replace manual-resize contracts with absence and autosize coverage.

### Task 1: Test the grip-free autosizing composer

**Files:**
- Modify: `tests/components/AnnotationThread.test.ts:120-200, 440-450`

- [ ] **Step 1: Replace grip tests with a test that the opened composer has no resize element.**

```ts
openComposer(tree)
expect(tree.root.findAllByProps({
  className: 'elves-annotation-thread__reply-resize',
})).toHaveLength(0)
```

Delete all assertions about separator semantics, Arrow key handling, pointer capture, pointer dragging, `aria-valuemin`, `aria-valuenow`, and disabled resize interaction.

- [ ] **Step 2: Assert automatic sizing comes only from the draft content and 76px baseline.**

```ts
const input = { scrollHeight: 104, style: {} as CSSStyleDeclaration }
const tree = create(element, { createNodeMock: () => input })
openComposer(tree)
expect(input.style.height).toBe('104px')
act(() => tree.root.findByType('textarea').props.onChange({ target: { value: '' } }))
expect(input.style.height).toBe('76px')
```

Use a textarea-specific `createNodeMock` so the ref sees `scrollHeight` and `style`; return `null` for other elements. Preserve existing disclosure, Send, and disabled/running tests.

- [ ] **Step 3: Change the CSS contract to forbid the selector.**

```ts
expect(css).not.toContain('.elves-annotation-thread__reply-resize')
expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea\s*\{[^}]*resize:\s*none/s)
```

Keep the existing Send `right: 8px; bottom: 8px` and textarea focus/padding assertions.

- [ ] **Step 4: Run the focused test before implementation.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts`

Expected: FAIL because the resize grip remains and the layout effect still uses a manual minimum.

### Task 2: Remove manual resizing and keep automatic growth

**Files:**
- Modify: `src/components/AnnotationThread.tsx:1-109, 153-178`
- Modify: `src/components/annotationThread.css:35, 43, 45-46`
- Test: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Delete manual-resize imports, state, and handlers.**

```ts
// Remove KeyboardEvent and PointerEvent imports.
// Remove replyMinimumHeight, replyResize, beginReplyResize,
// resizeReply, endReplyResize, and resizeReplyWithKeyboard.
```

Do not change public props, the Reply trigger, Send guards, Resolve, Close, Retry, or message rendering.

- [ ] **Step 2: Make autosize depend only on content and the 76px baseline.**

```ts
useLayoutEffect(() => {
  const input = replyInputRef.current
  if (!composerOpen || !input) return
  input.style.height = 'auto'
  input.style.height = `${Math.max(input.scrollHeight, REPLY_MIN_HEIGHT)}px`
}, [composerOpen, reply])
```

Remove the textarea inline `minHeight` style and remove the manual-minimum reset from `send`; the CSS `min-height: 76px` remains the baseline.

- [ ] **Step 3: Remove the resize separator and every grip CSS rule.**

```tsx
// Delete the complete <div className="elves-annotation-thread__reply-resize" ... />.
```

```css
/* Delete .elves-annotation-thread__reply-resize and every grouped hover,
   disabled, or focus-visible selector that names it. */
```

Retain `resize: none`, preserving an autosizing-only editor with no native or custom visible handle.

- [ ] **Step 4: Run the focused test to verify it passes.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only the scoped source and test files.**

```bash
git add src/components/AnnotationThread.tsx src/components/annotationThread.css tests/components/AnnotationThread.test.ts
git commit -m "Remove annotation reply resize grip"
```

### Task 3: Verify and update the existing stacked PR

**Files:**
- Modify: `src/components/AnnotationThread.tsx`
- Modify: `src/components/annotationThread.css`
- Modify: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Run complete verification.**

Run: `npm test && npm run typecheck && git diff --check`

Expected: full suite passes, TypeScript exits 0, and whitespace check prints nothing.

- [ ] **Step 2: Confirm staging excludes user work.**

Run: `git status --short && git diff --name-status c4a90c0...HEAD`

Expected: preserve unrelated `package*.json`, `src/main.tsx`, and untracked comment-states gallery files.

- [ ] **Step 3: Push the current branch and update PR #160.**

Run: `git push origin feat/annotation-thread-reply-composer`

Expected: PR #160 now contains the grip-free autosizing composer.
