# CardShape Page Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-card page scans with shared tldraw computed indexes whose per-card selectors only invalidate affected cards.

**Architecture:** A WeakMap owns one index bundle per `Editor`. Store computed caches project each shape record down to the fields relevant to card structure or fan layout, so move-only/content-only changes do not invalidate unrelated derivations. Per-card computed selectors use equality checks to prevent unaffected tracked Card components from rerendering.

**Tech Stack:** React 18, TypeScript, tldraw signals (`computed`, store computed caches, `react`), Vitest.

## Global Constraints

- Preserve lexicographic card numbering and current page-order merged-member rendering.
- Preserve the existing fan layout dependency key: `id`, `x`, `y`, and `parentId` for every current-page shape.
- Do not compute fan layout or read full member records for collapsed cards.
- Keep new indexing logic out of `CardShapeUtil.tsx`.

## Invalidation Evidence

`Editor.getCurrentPageShapes()` is a tldraw computed that iterates current-page IDs and reads every corresponding store record atom. `CardShapeUtil.component()` reads it at lines 400 and 497. Therefore any page-shape record replacement produces a new page array and invalidates every tracked Card component. Each invalidated card then independently:

1. filters the full page through `mergedMembers`;
2. maps the full page into `fanLayoutKey`, even while collapsed;
3. filters and lexicographically sorts every card;
4. linearly searches the sorted list for its number.

For `N` cards, one unrelated or move-only record update causes `N` page-array consumers and repeated `O(N log N)` sorting, even though card numbering and merge membership did not change.

---

### Task 1: Reactive page index regressions

**Files:**
- Create: `tests/shapes/cardPageIndex.test.ts`
- Test: `tests/shapes/cardPageIndex.test.ts`

**Interfaces:**
- Consumes: tldraw `atom` / `react` and a reactive fake `Editor` source.
- Produces: executable contracts for `cardPageInfo(editor, cardId)` and `expandedCardFanInfo(editor, cardId)`.

- [x] **Step 1: Write failing performance tests**

Create 100 card consumers and assert a move-only update leaves the shared structural scan count and every consumer run count unchanged. Change one card's `mergedInto` and assert only the representative consumer reruns. Assert no fan-layout cache is touched until `expandedCardFanInfo` has an active consumer.

- [x] **Step 2: Write failing behavior tests**

Assert `cardPageInfo` returns lexicographic `cardNumber` / `cardCount`, merged IDs retain page order, and expanded fan data returns the legacy `id:x:y:parentId` key plus current member records.

- [x] **Step 3: Verify RED**

Run: `npm test -- tests/shapes/cardPageIndex.test.ts`

Expected: FAIL because `src/shapes/cardPageIndex.ts` does not exist.

### Task 2: Shared tldraw indexes

**Files:**
- Create: `src/shapes/cardPageIndex.ts`
- Test: `tests/shapes/cardPageIndex.test.ts`

**Interfaces:**
- Produces: `cardPageInfo(editor: Editor, cardId: CardShape['id']): CardPageInfo`.
- Produces: `expandedCardFanInfo(editor: Editor, cardId: CardShape['id']): ExpandedCardFanInfo`.

- [x] **Step 1: Implement semantic record caches**

Create one WeakMap-cached bundle per editor. The structural cache compares only shape type and `props.mergedInto`; the fan-layout cache compares only `id`, `x`, `y`, and `parentId`.

- [x] **Step 2: Implement shared and per-card computed selectors**

The shared structure computed scans current-page IDs once, preserves page-order member IDs, and sorts card IDs once. A cached per-card computed returns number, total, and member IDs with value equality. A lazy fan computed builds the legacy layout key; a per-card fan selector reads full records only for that representative's members.

- [x] **Step 3: Verify GREEN**

Run: `npm test -- tests/shapes/cardPageIndex.test.ts`

Expected: all index behavior and instrumentation tests pass.

### Task 3: CardShape integration

**Files:**
- Modify: `src/shapes/CardShapeUtil.tsx:19,400-441,497-500`
- Test: `tests/shapes/cardPageIndex.test.ts`

**Interfaces:**
- Consumes: `cardPageInfo` and `expandedCardFanInfo` from Task 2.

- [x] **Step 1: Replace structural page scans**

Read `cardNumber`, `cardCount`, and `memberIds.length` from `cardPageInfo`. Remove both direct `getCurrentPageShapes()` calls and the per-render sort.

- [x] **Step 2: Gate fan reads by expansion**

Call `expandedCardFanInfo` only when `mergedCount > 0 && isExpanded(shape.id)`. Use its members and layout key for the existing fan effect; collapsed cards use empty members and an empty key.

- [x] **Step 3: Verify behavior and repository gates**

Run: `npm test -- tests/shapes/cardPageIndex.test.ts tests/shapes/mergeView.test.ts`

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Run the relevant merge/fan e2e test selected from `e2e/`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-07-14-cardshape-page-index.md src/shapes/cardPageIndex.ts src/shapes/CardShapeUtil.tsx tests/shapes/cardPageIndex.test.ts
git commit -m "perf(canvas): share card page indexes"
```
