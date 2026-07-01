# Elves Phase 3b (Transcription) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude read an image card of handwritten notes and faithfully transcribe it into a **text source card** next to the image, via a new `create_source_card` op/tool — Claude creating *source* cards (your handwriting, digitized), never prose.

**Architecture:** A new `create_source_card` change-set op creates a source card (`origin: 'transcribed'`) at a position; the `changeSetWritesText` guard is updated to *allow* it (new source, not prose or an edit). The `read_canvas`/`GET /cards` digest exposes each image card's absolute file path (`assetPath`) so Claude Code reads the image with its native vision. A `create_source_card` MCP tool (the fifth) posts the op through the existing `/changeset` machinery, and the Claude skill gains the transcription workflow.

**Tech Stack:** TypeScript, tldraw v3, Express, `@modelcontextprotocol/sdk`, `zod`, Vitest, Playwright. No new dependencies.

## Global Constraints

Copied from the Phase 3 spec; every task inherits these.

- `create_source_card` creates a **source** card only (`kind: 'source'`, `sourceKind: 'text'`, `origin: 'transcribed'`) with the given text at a position. It can never create a prose card or edit an existing card.
- The `changeSetWritesText` guard **allows** `create_source_card` (a new source card), while still rejecting anything that would write prose or edit an existing card's text, and still failing closed on unknown ops.
- `origin` gains `'transcribed'` — additive to the enum, **no migration** (it only widens the allowed set; existing records with `tana`/`image`/`typed` still validate).
- `read_canvas` (`GET /cards`) exposes each image card's **absolute file path** as `assetPath` (null for non-image cards).
- Transcription is **faithful** (the user's words digitized, not summarized); **one source card per image** by default (Claude may split if the page clearly holds separate notes); **direct + undoable**.
- The MCP server now exposes **five** tools: `read_canvas`, `add_comment`, `merge_sources`, `move_cards`, `create_source_card`. Still no card-text-editing tool.

## Project Layout (changed by this plan)

```
src/model/
  changeset.ts    # Op += create_source_card; isOp/changeSetWritesText updated   (Task 1)
  types.ts        # Origin += 'transcribed'                                       (Task 1)
src/shapes/
  CardShapeUtil.tsx  # origin validator += 'transcribed'                          (Task 1)
src/apply/
  applyChangeSet.ts  # applyCreateSourceCard                                      (Task 2)
server/
  digest.ts       # snapshotToCards(snapshot, assetsDir?) adds assetPath          (Task 3)
  app.ts          # GET /cards passes assetsDir                                   (Task 3)
mcp/
  tools.ts        # createSourceCardTool                                          (Task 4)
  index.ts        # register the 5th tool                                         (Task 4)
skill/
  elves-canvas.md # transcription workflow                                        (Task 4)
tests/
  model/changeset.test.ts, model/guard.test.ts   (Task 1)
  server/digest.test.ts, server/changeset.test.ts (Task 3)
  mcp/tools.test.ts, mcp/server.test.ts            (Task 4)
e2e/
  transcribe.spec.ts   (Task 2)
```

> **tldraw API note:** Task 1 widens the `origin` `T.literalEnum` — this is additive and needs no migration, but Task 2's e2e (which loads the app) plus the existing specs confirm old cards still load. Task 2 uses `editor.createShape` + `createShapeId` inside the existing `applyChangeSet` undo-wrapper. Verify against installed tldraw 3.15.6 if anything fails.

---

### Task 1: Model — `create_source_card` op, guard, `transcribed` origin

**Files:**
- Modify: `src/model/changeset.ts`, `src/model/types.ts`, `src/shapes/CardShapeUtil.tsx`, `tests/model/changeset.test.ts`, `tests/model/guard.test.ts`

**Interfaces:**
- Produces:
  - `Op` gains `{ kind: 'create_source_card'; text: string; x: number; y: number }`.
  - `isChangeSet`/`isOp` validate it; `changeSetWritesText` returns `false` for it.
  - `Origin` = `'tana' | 'image' | 'typed' | 'transcribed'`; the shape's `origin` validator accepts `'transcribed'`.

- [ ] **Step 1: Add the op to the changeset test**

In `tests/model/changeset.test.ts`, extend the valid-change-set test's `ops` array with a create op and add a rejection case:
```ts
// add to the well-formed ops array in the "accepts a well-formed change-set" test:
{ kind: 'create_source_card', text: 'transcribed words', x: 10, y: 20 },
```
And add:
```ts
test('rejects a malformed create_source_card', () => {
  expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'create_source_card', text: 'hi' }] })).toBe(false) // missing x/y
})
```

- [ ] **Step 2: Extend the guard test**

In `tests/model/guard.test.ts`, add `create_source_card` to the all-safe assertion — add this op to the change-set in the "none of the Phase 2 ops write card text" test:
```ts
{ kind: 'create_source_card' as const, text: 'note', x: 1, y: 2 },
```
(The existing test then asserts `changeSetWritesText(cs)` is `false` for all of them.)

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/model/changeset.test.ts tests/model/guard.test.ts`
Expected: FAIL — `isOp` rejects the new kind (well-formed test fails) / guard returns true for it.

- [ ] **Step 4: Add the op, guard case, and origin value**

In `src/model/changeset.ts`, add to the `Op` union:
```ts
  | { kind: 'create_source_card'; text: string; x: number; y: number }
```
Add the `isOp` case:
```ts
    case 'create_source_card':
      return typeof op.text === 'string' && typeof op.x === 'number' && typeof op.y === 'number'
```
Add `create_source_card` to the safe branch of `changeSetWritesText`:
```ts
      case 'add_comment':
      case 'merge_sources':
      case 'move_cards':
      case 'create_source_card':
        return false
      default:
        return true // unknown op: treat as unsafe
```
(Update the `changeSetWritesText` doc comment to note it returns true iff an op would write **prose** text or edit an **existing** card's text — `create_source_card` creates a *new source* card, so it's allowed.)

In `src/model/types.ts`, widen `Origin`:
```ts
export type Origin = 'tana' | 'image' | 'typed' | 'transcribed'
```

In `src/shapes/CardShapeUtil.tsx`, widen the origin validator:
```ts
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed', 'transcribed')),
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- tests/model/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/changeset.ts src/model/types.ts src/shapes/CardShapeUtil.tsx tests/model/changeset.test.ts tests/model/guard.test.ts
git commit -m "feat: create_source_card op + guard + transcribed origin"
```

---

### Task 2: Applier — `create_source_card`

**Files:**
- Modify: `src/apply/applyChangeSet.ts`
- Create: `e2e/transcribe.spec.ts`

**Interfaces:**
- Consumes: `Op` (`create_source_card`) from `src/model/changeset`; `makeSourceCardProps` (`src/model/cards`); `CardShape`.
- Produces: `applyChangeSet` also handles `create_source_card` — creates a source card (`origin: 'transcribed'`) at the op's `x`/`y`, inside the existing single-undo wrapper.

- [ ] **Step 1: Write the failing e2e**

`e2e/transcribe.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('create_source_card renders a transcribed source card, undoable', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await request.post(`${BASE}/changeset`, {
    data: { id: 't1', author: 'claude', ops: [
      { kind: 'create_source_card', text: 'my handwriting, typed', x: 200, y: 200 },
    ] },
  })

  const card = page.locator('.elves-card--source', { hasText: 'my handwriting, typed' })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('card-badge')).toHaveText('transcribed')

  await page.mouse.click(60, 300) // focus the canvas so Ctrl-Z reaches tldraw
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-card--source', { hasText: 'my handwriting, typed' })).toHaveCount(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/transcribe.spec.ts`
Expected: FAIL — `create_source_card` isn't applied (no card appears).

- [ ] **Step 3: Implement the applier handler**

In `src/apply/applyChangeSet.ts`, import the factory and `createShapeId`:
```ts
import { createShapeId } from 'tldraw'
import { makeSourceCardProps } from '../model/cards'
```
Add the handler and wire it into `applyOp`:
```ts
function applyCreateSourceCard(editor: Editor, op: Extract<Op, { kind: 'create_source_card' }>): void {
  editor.createShape<CardShape>({
    id: createShapeId(),
    type: 'card',
    x: op.x,
    y: op.y,
    props: makeSourceCardProps(op.text, 'transcribed'),
  })
}
```
In the `applyOp` switch:
```ts
    case 'create_source_card':
      applyCreateSourceCard(editor, op)
      break
```
(`applyChangeSet` already wraps `applyOp` in `markHistoryStoppingPoint` + `squashToMark`, so one Ctrl-Z reverts the create.)

- [ ] **Step 4: Run to verify it passes**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/transcribe.spec.ts`
Expected: PASS — the transcribed source card renders and one Ctrl-Z removes it.

- [ ] **Step 5: Full suite**

Run: `npm test && npm run typecheck && rm -f .e2e/canvas.json && npm run e2e`
Expected: all green (existing cards still load with the widened origin enum).

- [ ] **Step 6: Commit**

```bash
git add src/apply/applyChangeSet.ts e2e/transcribe.spec.ts
git commit -m "feat: apply create_source_card (transcribed source card)"
```

---

### Task 3: Digest — `assetPath` for image cards

**Files:**
- Modify: `server/digest.ts`, `server/app.ts`, `tests/server/digest.test.ts`, `tests/server/changeset.test.ts`

**Interfaces:**
- Consumes: `resolveAssetPath`, `assetsDir` (`server/assets`).
- Produces:
  - `CardDigest` gains `assetPath: string | null`.
  - `snapshotToCards(snapshot: CanvasSnapshot, assetsDir?: string): CardDigest[]` — sets `assetPath` to the absolute file path for image cards (when `assetsDir` is given and the card is `sourceKind: 'image'` with an `assetId`), else `null`.
  - `GET /cards` passes `assetsDir(dataPath)`.

- [ ] **Step 1: Update the digest tests**

In `tests/server/digest.test.ts`, add `assetPath: null` to the expected object in the existing prose/source `toEqual` (both projected cards get `assetPath: null` when no `assetsDir` is passed), and add:
```ts
import { resolveAssetPath } from '../../server/assets'

test('snapshotToCards resolves assetPath for image cards when given an assets dir', () => {
  const snapshot = {
    document: { store: { 'shape:i': {
      id: 'shape:i', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 280, h: 200, kind: 'source', sourceKind: 'image', origin: 'image', text: '', comments: [], mergedInto: null, assetId: 'pic.png' },
    } } },
    session: null,
  }
  const [card] = snapshotToCards(snapshot, '/assets')
  expect(card.assetPath).toBe(resolveAssetPath('/assets', 'pic.png'))
  expect(snapshotToCards(snapshot)[0].assetPath).toBeNull() // no assetsDir → null
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/server/digest.test.ts`
Expected: FAIL — `assetPath` missing.

- [ ] **Step 3: Add `assetPath` to the digest**

In `server/digest.ts`, import the resolver, extend the type, and add the field:
```ts
import { resolveAssetPath } from './assets'
```
Add to `CardDigest`:
```ts
  assetPath: string | null
```
Change the signature and the mapping:
```ts
export function snapshotToCards(snapshot: CanvasSnapshot, assetsDir?: string): CardDigest[] {
  // ... existing doc/store resolution ...
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'card' && r.props)
    .map((r: any) => ({
      // ... existing fields ...
      assetPath:
        assetsDir && r.props.sourceKind === 'image' && r.props.assetId
          ? resolveAssetPath(assetsDir, r.props.assetId)
          : null,
    }))
}
```

- [ ] **Step 4: Pass `assetsDir` from `GET /cards`**

In `server/app.ts`, update the `/cards` route and import `assetsDir` (already imported for `/assets`):
```ts
  app.get('/cards', async (_req, res) => {
    res.json(snapshotToCards(await readCanvas(dataPath), assetsDir(dataPath)))
  })
```

- [ ] **Step 5: Update the GET /cards integration test**

In `tests/server/changeset.test.ts`, the existing `GET /cards` test compares against `snapshotToCards(snap)`. Update it to pass the same assets dir the server uses so the expectation matches — compare against `snapshotToCards(snap, assetsDir(<the tmp canvas path used>))`, or simply assert the shape of the returned card includes `assetPath` (null for the text card in that test). Minimal change: import `assetsDir` and compare `res.body` to `snapshotToCards(snap, assetsDir(canvasPath))` using the same path passed to `createServer`.

- [ ] **Step 6: Run the server tests**

Run: `npm test -- tests/server/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/digest.ts server/app.ts tests/server/digest.test.ts tests/server/changeset.test.ts
git commit -m "feat: expose image assetPath in the read_canvas digest"
```

---

### Task 4: MCP — `create_source_card` tool + transcription skill

**Files:**
- Modify: `mcp/tools.ts`, `mcp/index.ts`, `tests/mcp/tools.test.ts`, `tests/mcp/server.test.ts`, `skill/elves-canvas.md`

**Interfaces:**
- Consumes: `makeChangeSet`, `postChangeSet` (`mcp/tools`/`mcp/elvesClient`).
- Produces:
  - `createSourceCardTool(baseUrl: string, args: { text: string; x: number; y: number }): Promise<void>`.
  - The MCP server registers a fifth tool, `create_source_card`.
  - The skill documents the transcription workflow (read the image `assetPath`, transcribe faithfully, `create_source_card`).

- [ ] **Step 1: Write the failing tests**

In `tests/mcp/tools.test.ts`, add an integration test (reuses the `liveElves()` helper + a ws client):
```ts
import { createSourceCardTool } from '../../mcp/tools'

test('createSourceCardTool posts a create_source_card change-set', async () => {
  const base = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await createSourceCardTool(base, { text: 'typed handwriting', x: 5, y: 6 })

  const cs = await received
  expect(cs.author).toBe('claude')
  expect(cs.ops).toEqual([{ kind: 'create_source_card', text: 'typed handwriting', x: 5, y: 6 }])
  ws.close()
})
```
In `tests/mcp/server.test.ts`, update the expected tool list to five names:
```ts
  expect(names).toEqual(['add_comment', 'create_source_card', 'merge_sources', 'move_cards', 'read_canvas'])
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/mcp/`
Expected: FAIL — `createSourceCardTool` missing / tool list has four names.

- [ ] **Step 3: Add the tool handler**

In `mcp/tools.ts`:
```ts
export function createSourceCardTool(
  baseUrl: string,
  args: { text: string; x: number; y: number },
): Promise<void> {
  return postChangeSet(baseUrl, makeChangeSet([
    { kind: 'create_source_card', text: args.text, x: args.x, y: args.y },
  ]))
}
```

- [ ] **Step 4: Register the MCP tool**

In `mcp/index.ts`, import `createSourceCardTool` and register (after `move_cards`):
```ts
  server.tool(
    'create_source_card',
    "Create a SOURCE card containing text you transcribed from an image. First read the image card's file (read_canvas gives each image card an `assetPath`), then transcribe the handwriting FAITHFULLY — these are the user's own words; digitize them, do not summarize. Position (x, y) near the image. Creates a SOURCE card only — never a prose card.",
    { text: z.string(), x: z.number(), y: z.number() },
    async ({ text, x, y }) => {
      await createSourceCardTool(baseUrl, { text, x, y })
      return { content: [{ type: 'text', text: 'source card created' }] }
    },
  )
```

- [ ] **Step 5: Run the MCP tests**

Run: `npm test -- tests/mcp/`
Expected: PASS — the integration test and the five-tool assertion green.

- [ ] **Step 6: Add the transcription workflow to the skill**

In `skill/elves-canvas.md`, add `create_source_card` to the "What you can do" list and add a section:
```markdown
## Transcribing handwritten notes (images)

Image cards (a `source` card showing an image) include an `assetPath` in `read_canvas`
— the local file of the picture. To transcribe one:

1. `read_canvas` to find the image card and its `assetPath`.
2. Read the image file at that path (you can see it) and transcribe the handwriting
   **as faithfully as you can** — these are the user's own words; you are digitizing
   them, not summarizing. Preserve their wording.
3. `create_source_card` with the transcribed text, positioned just to the right of the
   image. One source card per image by default; split into a few only if the page
   clearly holds separate notes.

You create **source** cards, never prose. The transcription is the user's own words as
reference material they'll distill later.
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npm run typecheck && rm -f .e2e/canvas.json && npm run e2e`
Expected: all unit, typecheck, and Playwright specs green.

- [ ] **Step 8: Commit**

```bash
git add mcp/tools.ts mcp/index.ts tests/mcp/tools.test.ts tests/mcp/server.test.ts skill/elves-canvas.md
git commit -m "feat: create_source_card MCP tool + transcription skill workflow"
```

---

## Phase 3b Definition of Done
- A `create_source_card` op creates a `transcribed`-origin source card at a position, applied live and undoable; `changeSetWritesText` permits it but still rejects prose/existing-text writes and unknown ops.
- `read_canvas` exposes each image card's absolute `assetPath`.
- The MCP server exposes five tools (the new `create_source_card`), and the skill documents the read-image → transcribe-faithfully → create-source-card workflow.
- Manual acceptance (Claude-in-the-loop, not automatable): with the app + MCP server running, "transcribe this image" reads the image file, faithfully types the handwriting into a source card next to it, and never writes a prose card.
- `npm test`, `npm run typecheck`, and `npm run e2e` all green.

## Self-Review (done during authoring)
- **Spec coverage:** `create_source_card` source-only op (§6) → Tasks 1, 2; guard allows it (§7) → Task 1; `origin: 'transcribed'` additive (§6) → Task 1; `assetPath` in digest (§6) → Task 3; MCP tool (§6, §8) → Task 4; faithful-transcription + one-per-image skill (§6) → Task 4; direct+undoable (§6) → Task 2 e2e. Deferred items (MDX, `derivedFrom` links) correctly absent.
- **Placeholder scan:** none; every code/test step is complete. (Task 3 Step 5 describes a test update in prose but with the exact comparison expression to use — no invented code.)
- **Type consistency:** the `create_source_card` op shape `{ text, x, y }` is identical across `changeset.ts` (Task 1), the applier (Task 2), `createSourceCardTool` (Task 4), and the tests; `Origin` includes `'transcribed'` in `types.ts` and the validator (Task 1) and is produced by `makeSourceCardProps(text, 'transcribed')` in the applier (Task 2); `CardDigest.assetPath` consistent across `digest.ts` and its consumers (Task 3); the five tool names match across `index.ts`, `server.test.ts`, and the skill (Task 4).
