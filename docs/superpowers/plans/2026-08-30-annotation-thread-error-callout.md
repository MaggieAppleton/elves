# Annotation Thread Error Callout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present failed annotation replies as red Warning callouts with a right-aligned Retry action.

**Architecture:** Change only shared AnnotationThread markup and stylesheet, retaining existing alert and retry callback behavior. Tests exercise the DOM contract and CSS wrapping/action geometry; both canvas and gallery consume this component unchanged.

**Tech Stack:** React, Phosphor icons, CSS custom properties, Vitest/react-test-renderer.

---

### Task 1: Add red-callout failing tests

**Files:**
- Modify: `tests/components/AnnotationThread.test.ts:41-66, 303-321, 375-394`

- [ ] **Step 1: Add DOM assertions for the alert structure.**

```ts
const alert = tree.root.findByProps({ className: 'elves-annotation-thread__error' })
expect(alert.props.role).toBe('alert')
expect(alert.findAllByType('svg')).toHaveLength(1)
expect(alert.findByProps({ className: 'elves-annotation-thread__error-message' }).children.join(''))
  .toContain('The reply stopped.')
expect(alert.findByProps({ className: 'elves-annotation-thread__retry' })).toBeTruthy()
```

- [ ] **Step 2: Add CSS contracts for safe callout layout.**

```ts
expect(css).toMatch(/\.elves-annotation-thread__error\s*\{[^}]*display:\s*flex/s)
expect(css).toMatch(/\.elves-annotation-thread__error\s*\{[^}]*border:\s*1px solid var\(--elves-danger/s)
expect(css).toMatch(/\.elves-annotation-thread__error-message\s*\{[^}]*min-width:\s*0/s)
expect(css).toMatch(/\.elves-annotation-thread__error-message[^}]*overflow-wrap:\s*anywhere/s)
expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*margin-left:\s*auto/s)
expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*flex:\s*0 0 auto/s)
```

Retain running/disabled Retry tests. Run `npx vitest run tests/components/AnnotationThread.test.ts`; expect failure before markup/CSS changes.

### Task 2: Implement the shared error callout

**Files:**
- Modify: `src/components/AnnotationThread.tsx:142-151`
- Modify: `src/components/annotationThread.css:35-40`
- Modify: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Structure the existing alert as message plus action.**

```tsx
<div className="elves-annotation-thread__error" role="alert">
  <div className="elves-annotation-thread__error-message">
    <Warning aria-hidden="true" size={16} weight="fill" />
    <span>{error}</span>
  </div>
  {onRetry && <button className="elves-annotation-thread__retry" ...>Retry</button>}
</div>
```

Use the existing Warning import and preserve the current button type, disabled expression, and guarded onClick callback exactly.

- [ ] **Step 2: Style a wrapping red callout with a non-shrinking right action.**

```css
.elves-annotation-thread__error {
  display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px;
  border: 1px solid var(--elves-danger, #b42318); border-radius: 8px;
  background: color-mix(in oklch, var(--elves-danger, #b42318) 10%, var(--elves-surface));
  color: var(--elves-danger, #b42318); font-size: 12px;
}
.elves-annotation-thread__error-message { display: flex; flex: 1 1 auto; min-width: 0; gap: 7px; }
.elves-annotation-thread__error-message span { min-width: 0; overflow-wrap: anywhere; line-height: 1.45; }
.elves-annotation-thread__retry { flex: 0 0 auto; align-self: flex-end; margin-left: auto; }
```

Add a 1px icon top alignment. Make Retry’s border/text use the danger token, with its hover treatment inverting to danger background and surface text; retain its disabled and focus styling.

- [ ] **Step 3: Run focused tests and typecheck.**

Run: `npx vitest run tests/components/AnnotationThread.test.ts tests/components/AnnotationPopoverLayer.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit only source and tracked test files.**

```bash
git add src/components/AnnotationThread.tsx src/components/annotationThread.css tests/components/AnnotationThread.test.ts
git commit -m "Polish annotation reply error callout"
```

### Task 3: Verify and update PR #160

**Files:**
- Modify: `src/components/AnnotationThread.tsx`
- Modify: `src/components/annotationThread.css`
- Modify: `tests/components/AnnotationThread.test.ts`

- [ ] **Step 1: Run `npm test && npm run typecheck && git diff --check`.**

Expected: full suite passes, TypeScript exits 0, and whitespace check is empty.

- [ ] **Step 2: Push `feat/annotation-thread-reply-composer` to update PR #160.**

Expected: the shared red error callout is visible in its canvas and gallery consumers without adding gallery-specific code.
