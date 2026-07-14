# Card Page Index Cache Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove constant-time per-card numbering and release cached selectors/full fan records when card records leave the store.

**Architecture:** Store page-info selectors in tldraw's record-atom weak cache so live inactive-page records retain identity but deleted records do not. Keep fan results uncached and derive them only during expanded tracked reads.

**Tech Stack:** TypeScript, tldraw signals/store caches, Vitest, Playwright.

---

### Task 1: Regression instrumentation

**Files:**
- Modify: `tests/shapes/cardPageIndex.test.ts`
- Modify: `src/shapes/cardPageIndex.ts`

- [x] **Step 1: Add failing lookup and lifecycle tests**

Extend the reactive editor harness with record-atom cache instrumentation and add tests that:

```ts
const firstInfo = cardPageInfo(editor, inactiveId)
const previousFanInfo = expandedCardFanInfo(editor, representativeId)
expect(stats.cardNumberLookups).toBe(cardCount)
expect(linearNumberScans).toBe(0)
expect(harness.cacheEntries('card page info')).toBeLessThanOrEqual(harness.liveRecordCount())
expect(cardPageInfo(editor, inactiveId)).toBe(firstInfo)
expect(expandedCardFanInfo(editor, representativeId)).not.toBe(previousFanInfo)
```

The churn must add, visit, retype, delete, and switch between page-id sets. It must expand a fan before deleting its former member.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/shapes/cardPageIndex.test.ts`

Expected: FAIL because current selectors live in strong `Map`s, fan results are cached, and lookup diagnostics are absent.

### Task 2: Weak selectors and stateless fan reads

**Files:**
- Modify: `src/shapes/cardPageIndex.ts`
- Test: `tests/shapes/cardPageIndex.test.ts`

- [x] **Step 1: Implement the weak page-info cache**

Replace the strong selector map with a store record cache:

```ts
const infoByCard = editor.store.createCache<CardPageInfo, CardShape>((cardId) =>
  computed(`card page info ${cardId}`, () => selectCardInfo(pageIndex.get(), cardId), {
    isEqual: cardInfoEqual,
  }),
)
```

Return an empty page-info value only if the record no longer exists.

- [x] **Step 2: Remove cached fan results**

Read expanded fan data directly:

```ts
const getExpandedFanInfo = (cardId: CardId) => {
  const memberIds = getCardInfo(cardId).memberIds
  const members = memberIds.flatMap((id) => {
    const member = editor.getShape<CardShape>(id)
    return member?.type === 'card' ? [member] : []
  })
  return { layoutKey: fanLayoutKey.get(), members }
}
```

- [x] **Step 3: Verify GREEN and regressions**

Run: `npm test -- tests/shapes/cardPageIndex.test.ts tests/shapes/mergeView.test.ts`

Expected: all focused tests pass.

Run: `npm test && npm run typecheck && npm run build`

Expected: all repository gates pass.

Run: `npm run e2e -- e2e/changes.spec.ts e2e/comments.spec.ts`

Expected: merge/fan and accessibility behavior pass.

- [x] **Step 4: Review and commit**

Run: `git diff --check && git status --short`

Commit:

```bash
git add src/shapes/cardPageIndex.ts tests/shapes/cardPageIndex.test.ts docs/superpowers/plans/2026-07-14-cardshape-page-index-cache-lifetime.md
git commit -m "perf(canvas): bound card page selector caches"
```
