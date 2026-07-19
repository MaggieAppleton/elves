# Draft Visual Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Figures and image cards appear in the final linear draft beside prose, using the same canvas-to-linear ordering rule.

**Architecture:** Keep `src/model/draft.ts` as the shared compiler for the pane, Markdown export, server `/draft`, and MCP `read_draft`. Replace prose-only card outputs with typed draft items: prose paragraphs, figure placeholders, and image assets, while preserving section bands left-to-right and card order top-to-bottom within each band.

**Tech Stack:** TypeScript, React, tldraw, Vitest, Playwright where needed.

---

### Task 1: Shared Draft Model

**Files:**
- Modify: `src/model/draft.ts`
- Test: `tests/model/draft.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving:
- `compileDraft` orders prose, figures, and images together in one section.
- `toReadDraftBlocks` exposes typed items, including `figureTitle`, `figureStatus`, and `assetId`.
- `draftToMarkdown` emits prose paragraphs, figure placeholders, and Markdown image syntax in order.

- [x] **Step 2: Run model tests and verify failure**

Run: `npm test -- tests/model/draft.test.ts`
Expected: FAIL because the current compiler filters out non-prose cards and `DraftBlock.cards` cannot represent visuals.

- [x] **Step 3: Implement model changes**

Update `DraftCardInput` to include `noteKind`, `assetId`, `figureTitle`, and `figureStatus`. Replace `DraftBlockCard[]` with `DraftItem[]`, where each item has `type: 'prose' | 'figure' | 'image'`. Keep a backwards-compatible `cards` projection if required by callers during migration, but make `items` the canonical draft output.

- [x] **Step 4: Run model tests and verify pass**

Run: `npm test -- tests/model/draft.test.ts`
Expected: PASS.

### Task 2: Server and MCP Projection

**Files:**
- Modify: `server/digest.ts`
- Modify: `mcp/index.ts`
- Test: `tests/server/api.test.ts`
- Test: `tests/mcp/tools.test.ts` or existing MCP client tests if affected

- [x] **Step 1: Write failing tests**

Extend the `/projects/:id/draft` test to include a figure and image card between prose cards and assert the response preserves that order with typed items.

- [x] **Step 2: Run server/MCP tests and verify failure**

Run: `npm test -- tests/server/api.test.ts`
Expected: FAIL because server inputs do not pass visual metadata and the read contract is prose-only.

- [x] **Step 3: Implement server projection**

Pass `noteKind`, `assetId`, `figureTitle`, and `figureStatus` from snapshot card props into `compileDraft`. Update comments/tool descriptions from prose-only `cards` to typed `items`.

- [x] **Step 4: Run server/MCP tests and verify pass**

Run: `npm test -- tests/server/api.test.ts tests/mcp/tools.test.ts`
Expected: PASS. (Also required updating two stale pre-migration expectations in `tests/server/digest.test.ts` and `tests/mcp/tools.test.ts` that still asserted the old `cards` shape.)

### Task 3: Draft Pane Rendering and Markdown Export

**Files:**
- Modify: `src/components/DraftPane.tsx`
- Modify: `src/components/draft.css`
- Test: `tests/components/DraftPane.test.ts`

- [x] **Step 1: Write failing tests**

Add component tests showing:
- figure items render as figure blocks with title, status, and description;
- image items render an image block with an asset URL;
- copy-as-Markdown includes prose, figure placeholder text, and image Markdown in order.

- [x] **Step 2: Run component tests and verify failure**

Run: `npm test -- tests/components/DraftPane.test.ts`
Expected: FAIL because the pane only maps `block.cards` to paragraphs.

- [x] **Step 3: Implement pane rendering**

Map `block.items`. Keep prose items editable through `ProseEditor`. Render figures read-only as semantic `<figure>` blocks. Render image items as `<figure><img /></figure>` using `assetUrl(assetId)`.

- [x] **Step 4: Run component tests and verify pass**

Run: `npm test -- tests/components/DraftPane.test.ts`
Expected: PASS.

### Task 4: Verification, Review, PR

**Files:**
- No new files expected beyond changed implementation/tests.

- [x] **Step 1: Run focused verification**

Run: `npm test -- tests/model/draft.test.ts tests/components/DraftPane.test.ts tests/server/api.test.ts tests/mcp/tools.test.ts`
Expected: PASS.

- [x] **Step 2: Run broader verification**

Run: `npm test`
Expected: PASS. (1318/1319 pass; the one failure, `tests/server/reviewRun.test.ts > a broadcast failure after durable dismiss does not block response or rename`, reproduces identically on a clean `main` via `git stash` — pre-existing and unrelated to this work.)

- [x] **Step 3: Request code review**

Ask a subagent to review the diff against this plan, focused on ordering consistency, API compatibility, and UI rendering regressions.

- [x] **Step 4: Fix review findings**

Review came back clean — no findings. Nothing to fix.

- [x] **Step 5: Commit and push**

Committed the plan and implementation directly to `main` and pushed, per user instruction (no PR requested this time).
