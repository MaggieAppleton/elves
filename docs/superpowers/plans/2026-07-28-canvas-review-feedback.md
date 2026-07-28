# Canvas-wide agent feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every agent create movable, immutable floating feedback cards, and make reviewer personalities run canvas-wide through those same feedback actions.

**Architecture:** Introduce an agent-authored feedback shape that represents an unanchored annotation, while retaining the existing attached card comments for card-specific observations. Persist provenance directly on the feedback shape; reviewers supply their persona and review identifier through the same creation operation. The review panel becomes a bottom-right review home and renders resolved feedback history from the canvas snapshot rather than a second feedback store.

**Tech Stack:** React, TypeScript, tldraw, Express, Vitest, Playwright.

## Global Constraints

- Human users may move all shapes but may not edit agent-authored feedback text.
- A feedback item is anchored only when one card is its clear subject; otherwise it floats near the relevant cluster or at the far-left global edge.
- Reviewers read the canvas map and card details, not just compiled draft prose.
- Image interpretation and image-labelling are out of scope.
- Reviewer personas retain their current budgets and retry behavior.

---

### Task 1: Model a floating feedback annotation

**Files:**
- Create: `src/model/feedback.ts`
- Create: `src/shapes/FeedbackShapeUtil.tsx`
- Create: `src/shapes/feedback.css`
- Modify: `src/model/changeset.ts`
- Modify: `server/applyChangeSet.ts`
- Modify: `src/App.tsx`
- Test: `tests/model/feedback.test.ts`
- Test: `tests/model/changeset.test.ts`
- Test: `tests/server/api.test.ts`

**Interfaces:**
- Produces `FeedbackProps`, `makeFeedbackProps`, and the `feedback` tldraw shape.
- Produces `create_feedback` and `resolve_feedback` change-set operations.
- Consumes the current change-set author and optional review metadata.

- [ ] **Step 1: Write failing model and change-set tests**

```ts
expect(makeFeedbackProps('A missing bridge', 'claude', {
  type: 'structure', reviewId: 'rev-1', reviewer: 'architect',
})).toMatchObject({ text: 'A missing bridge', authoredBy: 'claude', resolved: false })

expect(isChangeSet({ id: 'cs-1', author: 'claude', ops: [
  { kind: 'create_feedback', text: 'A missing bridge', x: 10, y: 20,
    feedback: { type: 'structure', reviewId: 'rev-1', reviewer: 'architect' } },
]})).toBe(true)
```

- [ ] **Step 2: Run the focused tests and confirm the new symbols fail**

Run: `npx vitest run tests/model/feedback.test.ts tests/model/changeset.test.ts`

- [ ] **Step 3: Implement the shape and server application path**

```ts
export interface FeedbackProps {
  w: number; h: number; text: string; authoredBy: string
  type: CommentType | null; reviewId: string | null; reviewer: PersonalityId | null
  resolved: boolean
}

{ kind: 'create_feedback', text: string, x: number, y: number,
  feedback: { type: CommentType | null, reviewId?: string | null, reviewer?: PersonalityId | null } }
```

Register `FeedbackShapeUtil` with the editor, make its text non-editable, allow ordinary tldraw movement, and apply the operation by creating a `feedback` shape with the change-set author stamped into `authoredBy`.

- [ ] **Step 4: Add resolve behavior and server API coverage**

```ts
{ kind: 'resolve_feedback', feedbackId: string }
```

Change resolution to set `resolved: true` without deleting the shape, so history survives and active-canvas rendering can hide it.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/model/feedback.test.ts tests/model/changeset.test.ts tests/server/api.test.ts`

Commit: `git commit -am "Add floating agent feedback annotations"`

### Task 2: Make feedback visible to agents and safe to deduplicate

**Files:**
- Modify: `server/digest.ts`
- Modify: `server/selection.ts`
- Modify: `server/changeSetAdmission.ts`
- Modify: `server/changeSetIdentity.ts`
- Modify: `src/model/changeset.ts`
- Test: `tests/server/digest.test.ts`
- Test: `tests/server/selection.test.ts`
- Test: `tests/server/changeSetAdmission.test.ts`

**Interfaces:**
- Consumes feedback shapes created by Task 1.
- Produces `FeedbackDigest` entries in `read_map` and valid feedback ids for change-set admission.

- [ ] **Step 1: Write failing digest and admission tests**

```ts
expect(snapshotToCardMap(snapshot).feedback).toContainEqual({
  id: 'shape:f1', text: 'The middle has no bridge', x: -300, y: 0,
  authoredBy: 'claude', reviewer: 'architect', resolved: false,
})
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/server/digest.test.ts tests/server/selection.test.ts tests/server/changeSetAdmission.test.ts`

- [ ] **Step 3: Project feedback into the canvas digest**

```ts
export interface FeedbackDigest {
  id: string; text: string; x: number; y: number; authoredBy: string
  type: CommentType | null; reviewId: string | null; reviewer: PersonalityId | null
  resolved: boolean
}
```

Include resolved items in the digest so agents can avoid re-raising dismissed feedback, but exclude them from the active visual-summary candidates.

- [ ] **Step 4: Validate references and stable identities**

Add feedback ids to shape-type checks and make `resolve_feedback` reference an existing feedback shape. Include normalized feedback creation and resolution in change-set identity so retries remain idempotent.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/server/digest.test.ts tests/server/selection.test.ts tests/server/changeSetAdmission.test.ts`

Commit: `git commit -am "Expose feedback annotations to canvas agents"`

### Task 3: Unify reviewer behavior with canvas-wide feedback

**Files:**
- Modify: `src/model/reviews.ts`
- Modify: `server/reviews.ts`
- Modify: `server/app.ts`
- Modify: `skill/elves-canvas.md`
- Test: `tests/model/reviews.test.ts`
- Test: `tests/server/reviews.test.ts`
- Test: `tests/server/reviewRun.test.ts`

**Interfaces:**
- Consumes `create_feedback` from Task 1 and feedback digest entries from Task 2.
- Produces a review brief that directs each personality to inspect the full canvas and choose anchored versus floating feedback deliberately.

- [ ] **Step 1: Write failing review-brief and completion-count tests**

```ts
expect(composeBrief(PERSONALITIES.architect, review)).toContain('Read the canvas map FIRST')
expect(composeBrief(PERSONALITIES.architect, review)).toContain('create_feedback')
expect(countReviewFeedback(snapshot, 'rev-1')).toBe(2)
```

- [ ] **Step 2: Run focused review tests and confirm failure**

Run: `npx vitest run tests/model/reviews.test.ts tests/server/reviews.test.ts tests/server/reviewRun.test.ts`

- [ ] **Step 3: Update the shared reviewer instructions**

Require `read_map` and `read_cards` before feedback, treat `read_draft` as optional narrative-order context, retain budgets, and prescribe `add_comment` for one-card findings versus `create_feedback` for relationship, cluster, and global findings. Specify the far-left placement rule for essay-wide findings.

- [ ] **Step 4: Count both feedback forms and preserve retry safety**

```ts
export function countReviewFeedback(snapshot: CanvasSnapshot | null, reviewId: string): number
```

Count review-tagged attached comments and feedback shapes when completing a review. Preserve terminal state and do not recreate annotations from earlier attempts.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/model/reviews.test.ts tests/server/reviews.test.ts tests/server/reviewRun.test.ts`

Commit: `git commit -am "Run reviewer personas across the canvas"`

### Task 4: Build the bottom-right review home and resolved stack

**Files:**
- Modify: `src/components/ReviewPanel.tsx`
- Modify: `src/components/reviewPanel.css`
- Modify: `src/App.tsx`
- Modify: `src/theme.css`
- Test: `tests/components/ReviewPanel.test.tsx`
- Test: `e2e/reviews.spec.ts`

**Interfaces:**
- Consumes reviews plus feedback shapes from the active tldraw editor.
- Produces a fixed bottom-right control and a resolved-feedback stack grouped across all review runs.

- [ ] **Step 1: Write failing component and browser tests**

```tsx
expect(screen.getByRole('button', { name: /review/i })).toHaveClass('elves-review--home')
expect(screen.getByText("Devil's Advocate")).toBeVisible()
expect(screen.getByText('weak argument')).toBeVisible()
```

```ts
await page.getByRole('button', { name: /resolve feedback/i }).click()
await expect(page.locator('[data-feedback-stack]')).toContainText("Devil's Advocate")
```

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run: `npx vitest run tests/components/ReviewPanel.test.tsx`

Run: `npx playwright test e2e/reviews.spec.ts`

- [ ] **Step 3: Relocate the control and render provenance**

Move the panel from the topbar flow to a fixed bottom-right home. Show agent identity, reviewer persona when present, persona colour, and a feedback-type label. Keep active pass status and summoning behavior intact.

- [ ] **Step 4: Render the one resolved-feedback stack**

Derive resolved feedback shapes from the editor store, hide them from the active canvas, and show a single stack near the review home. A stack item must preserve provenance and offer a way to inspect or restore its canvas location without exposing content editing.

- [ ] **Step 5: Run focused UI tests and commit**

Run: `npx vitest run tests/components/ReviewPanel.test.tsx`

Run: `npx playwright test e2e/reviews.spec.ts`

Commit: `git commit -am "Move review home and add feedback history stack"`

### Task 5: Verify the integrated behavior

**Files:**
- Modify: `README.md`
- Modify: `skill/elves-canvas.md`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**
- Documents `create_feedback` and the anchored-versus-floating placement convention.

- [ ] **Step 1: Write failing MCP contract tests**

```ts
expect(toolNames).toContain('create_feedback')
expect(toolNames).toContain('resolve_feedback')
```

- [ ] **Step 2: Run focused MCP tests and confirm failure**

Run: `npx vitest run tests/mcp/server.test.ts tests/mcp/tools.test.ts`

- [ ] **Step 3: Document the unified feedback model**

Document the shared actions, authorship boundary, placement rules, full-canvas review scope, and the bottom-right review home.

- [ ] **Step 4: Run full verification**

Run: `npm run typecheck`

Run: `npm test -- --maxWorkers=1 --minWorkers=1`

Run: `npm run build:local`

- [ ] **Step 5: Review the diff and commit**

Run: `git diff --check && git status --short`

Commit: `git commit -am "Document canvas-wide agent feedback"`

