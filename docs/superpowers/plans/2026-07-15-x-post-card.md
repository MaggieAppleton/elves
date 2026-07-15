# X Post Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dropped X/Twitter status URLs render as a useful, polished native reference card even if X cannot be unfurled.

**Architecture:** Add pure URL parsing and display fallbacks in `src/model/references.ts`. `ReferenceCardFace` continues to render the common reference-card structure, adding a semantic X modifier only for status URLs so CSS can give that variant a distinctive, compact treatment. No third-party embed or X API is required.

**Tech Stack:** TypeScript, React, Vitest, Playwright, CSS.

---

### Task 1: Specify X status URL display fallbacks

**Files:**

- Modify: `tests/model/references.test.ts`
- Modify: `src/model/references.ts`

- [x] **Step 1: Write failing unit tests**

```ts
const xPost = ref({
  url: 'https://x.com/GergelyOrosz/status/2076959410941792548?s=20',
  refType: 'social',
})
expect(refEyebrow(xPost)).toBe('@GergelyOrosz')
expect(refTitle(xPost)).toBe('X post')
```

- [x] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/model/references.test.ts`

Expected: the current generic `x.com` fallback fails the title assertion.

- [x] **Step 3: Implement the minimal pure helpers**

```ts
export function xStatusHandle(url: string): string | null {
  // Return the first path segment for x.com/twitter.com /handle/status/id URLs.
}
```

Use it only when social metadata is absent: authors still win for the eyebrow and a real metadata title still wins for the title.

- [x] **Step 4: Run focused unit tests**

Run: `npm test -- tests/model/references.test.ts`

Expected: PASS.

### Task 2: Give X cards a provider-specific visual identity

**Files:**

- Modify: `src/shapes/ReferenceCardFace.tsx`
- Modify: `src/shapes/card.css`

- [x] **Step 1: Mark valid X/Twitter status cards**

```tsx
<div className="elves-ref" data-reftype={ref.refType} data-x-post={isXStatusUrl(ref.url) || undefined}>
```

- [x] **Step 2: Style the modifier**

Use a black X glyph, a restrained dark heading treatment, and a fine dark border accent. Preserve current social-card media and the accessible open-link control.

- [x] **Step 3: Run type checking**

Run: `npm run typecheck`

Expected: PASS.

### Task 3: Verify the URL-drop flow and rendered card

**Files:**

- Modify: `e2e/references.spec.ts`

- [x] **Step 1: Add a route-mocked drop/paste test**

Intercept the project unfurl request with a metadata-free X social reference, paste the requested X URL through `+ Link`, and assert `@GergelyOrosz`, `X post`, the X modifier, and its open URL.

- [x] **Step 2: Run focused browser test**

Run: `npm run e2e -- e2e/references.spec.ts`

Expected: PASS.

- [x] **Step 3: Inspect in Playwright and iterate CSS once if needed**

Run the local app with isolated project data, capture the X fallback card, and adjust only visual CSS that demonstrably harms readability or hierarchy.

### Task 4: Final verification and review

**Files:**

- Verify: `tests/model/references.test.ts`, `e2e/references.spec.ts`

- [x] **Step 1: Run focused tests, typecheck, and full test suite**

Run: `npm test -- tests/model/references.test.ts && npm run typecheck && npm test`

Expected: all commands PASS.

- [x] **Step 2: Request a fresh review**

Ask an independent reviewer to inspect the diff, tests, and visual behavior for regressions.

- [ ] **Step 3: Commit and open a pull request**

Run: `git add ... && git commit -m "feat: render X post reference cards" && gh pr create ...`
