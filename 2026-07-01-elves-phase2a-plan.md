# Elves Phase 2a (Canvas Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Elves canvas everything needed to receive **change-sets** — comments, source-merges, and card moves — apply each as a single natively-undoable tldraw transaction, render Claude's comments distinctly with resolve/dismiss, and persist it all; driven by a test harness (a `POST /changeset` endpoint), with **no Claude yet**.

**Architecture:** A change-set is an ordered list of typed ops (`add_comment`, `merge_sources`, `move_cards`). The Elves server gains a websocket and a `POST /changeset` endpoint that broadcasts a change-set to the open app. The app's websocket client hands each change-set to a pure-ish **applier** that translates ops into tldraw store mutations inside one undo step, then the existing debounced save persists it. Comments live as a new `comments[]` prop on the card shape (added via a shape-props migration so existing Phase 1 canvases still load); merged duplicates get a `mergedInto` prop and render hidden-but-recoverable.

**Tech Stack:** TypeScript, React 18, tldraw v3, Express, `ws` (server websocket), browser `WebSocket` (app), Vitest, Playwright.

## Global Constraints

Copied from the Phase 2 spec; every task inherits these.

- **No op writes any card's text.** Phase 2a implements exactly three ops — `add_comment`, `merge_sources`, `move_cards` — none of which touch a card's `text`. Comments are a separate field; merges rewrite nothing; moves change only position.
- **Everything is a tldraw store operation → native Ctrl‑Z undo.** The applier wraps each change-set so one Ctrl‑Z reverts the whole set.
- **x-axis = narrative order** (left earlier, right later); `move_cards` sets absolute positions.
- **Comment** shape is exactly `{ id, type: 'needs-evidence' | 'weak-argument' | 'needs-citation' | null, text, resolved, author: 'claude' }`. `null` type = freeform. Stored as a card `comments[]` prop. Resolve/dismiss → hidden, **kept (recoverable)**, not deleted.
- **Merge = collapse under `cardIds[0]`** (the representative); the others get `mergedInto = representativeId`, render hidden, and are recoverable. **Source cards only.**
- **Change-set** is exactly `{ id: string, author: 'claude', ops: Op[] }`.
- Local-first, single device, turn-based. The app must be open to receive change-sets.

## Project Layout (added/changed by this plan)

```
src/
  model/
    types.ts        # + Comment, CommentType; CardProps gains comments[], mergedInto   (Task 1)
    comments.ts     # pure comment helpers                                              (Task 1)
    cards.ts        # factories updated to default comments:[], mergedInto:null         (Task 1)
    changeset.ts    # Op union, ChangeSet, guards, planMerge                            (Task 2)
  shapes/
    CardShapeUtil.tsx  # props gain comments/mergedInto + migration; comment rendering  (Task 3, 5, 6)
    card.css           # comment pins + type colors + hidden/merged styles              (Task 5, 6)
  apply/
    applyChangeSet.ts  # translate ops -> undoable store mutations                      (Task 5, 6)
  client/
    realtime.ts        # browser WebSocket client                                       (Task 5)
  App.tsx              # connect realtime on mount, wire applier                        (Task 5)
server/
  realtime.ts     # attachRealtime(httpServer) -> { broadcast }                         (Task 4)
  app.ts          # createServer(dataPath, onChangeSet?) + POST /changeset              (Task 4)
  index.ts        # wire http + realtime + app                                          (Task 4)
tests/
  model/comments.test.ts        (Task 1)
  model/changeset.test.ts       (Task 2)
  shapes/migration.test.ts      (Task 3)
  server/changeset.test.ts      (Task 4)
e2e/
  comments.spec.ts   (Task 5)
  changes.spec.ts    (Task 6)
```

> **tldraw v3 API note:** Tasks 3, 5, 6 use tldraw APIs that must be verified against the installed version (3.15.6): shape-props migrations (`createShapePropsMigrationSequence`, `createShapePropsMigrationIds`), the `T.arrayOf`/`T.object` validators, `editor.run(...)`, `editor.markHistoryStoppingPoint(...)`, `editor.updateShape({ id, type, x, y, props })`, `editor.getShape(id)`, `editor.getCurrentPageShapes()`. Verify via context7 (`resolve-library-id` → `tldraw`, then `query-docs`) or tldraw.dev before writing those tasks; the run-test steps will surface drift.

---

### Task 1: Comment model + card props extension (pure)

**Files:**
- Modify: `src/model/types.ts`, `src/model/cards.ts`, `tests/model/cards.test.ts`
- Create: `src/model/comments.ts`, `tests/model/comments.test.ts`

**Interfaces:**
- Produces:
  - `type CommentType = 'needs-evidence' | 'weak-argument' | 'needs-citation'`
  - `interface Comment { id: string; type: CommentType | null; text: string; resolved: boolean; author: 'claude' }`
  - `CardProps` additionally has `comments: Comment[]` and `mergedInto: string | null`
  - `makeComment(id: string, text: string, type?: CommentType | null): Comment`
  - `addComment(comments: Comment[], comment: Comment): Comment[]`
  - `resolveComment(comments: Comment[], commentId: string): Comment[]`
  - `visibleComments(comments: Comment[]): Comment[]`
  - `makeProseCardProps`/`makeSourceCardProps` now include `comments: []`, `mergedInto: null`

- [ ] **Step 1: Extend the types**

In `src/model/types.ts`, add above `CardProps`:
```ts
export type CommentType = 'needs-evidence' | 'weak-argument' | 'needs-citation'

export interface Comment {
  id: string
  /** null = freeform comment. */
  type: CommentType | null
  text: string
  resolved: boolean
  author: 'claude'
}
```
And add two fields to the `CardProps` interface (after `text`):
```ts
  /** Claude-authored comments attached to this card. */
  comments: Comment[]
  /** If set, this source card was merged into the referenced representative card (hidden, recoverable). */
  mergedInto: string | null
```

- [ ] **Step 2: Write the failing comment-helpers test**

`tests/model/comments.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { makeComment, addComment, resolveComment, visibleComments } from '../../src/model/comments'

describe('comment helpers', () => {
  test('makeComment defaults to freeform, unresolved, claude-authored', () => {
    expect(makeComment('c1', 'thin here')).toEqual({
      id: 'c1', type: null, text: 'thin here', resolved: false, author: 'claude',
    })
    expect(makeComment('c2', 'no source', 'needs-evidence').type).toBe('needs-evidence')
  })

  test('addComment appends immutably', () => {
    const a = makeComment('c1', 'a')
    const out = addComment([], a)
    expect(out).toEqual([a])
  })

  test('resolveComment marks one resolved without touching others', () => {
    const a = makeComment('c1', 'a')
    const b = makeComment('c2', 'b')
    const out = resolveComment([a, b], 'c1')
    expect(out.find((c) => c.id === 'c1')!.resolved).toBe(true)
    expect(out.find((c) => c.id === 'c2')!.resolved).toBe(false)
  })

  test('visibleComments hides resolved ones', () => {
    const a = { ...makeComment('c1', 'a'), resolved: true }
    const b = makeComment('c2', 'b')
    expect(visibleComments([a, b])).toEqual([b])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- tests/model/comments.test.ts`
Expected: FAIL — cannot find module `../../src/model/comments`.

- [ ] **Step 4: Implement the helpers**

`src/model/comments.ts`:
```ts
import { Comment, CommentType } from './types'

export function makeComment(id: string, text: string, type: CommentType | null = null): Comment {
  return { id, type, text, resolved: false, author: 'claude' }
}

export function addComment(comments: Comment[], comment: Comment): Comment[] {
  return [...comments, comment]
}

export function resolveComment(comments: Comment[], commentId: string): Comment[] {
  return comments.map((c) => (c.id === commentId ? { ...c, resolved: true } : c))
}

export function visibleComments(comments: Comment[]): Comment[] {
  return comments.filter((c) => !c.resolved)
}
```

- [ ] **Step 5: Update the card factories and their test**

In `src/model/cards.ts`, add the two new fields to both factories:
```ts
export function makeProseCardProps(text = ''): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'prose', sourceKind: null, origin: null, text,
    comments: [], mergedInto: null,
  }
}

export function makeSourceCardProps(text = '', origin: Origin = 'typed'): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'source', sourceKind: 'text', origin, text,
    comments: [], mergedInto: null,
  }
}
```

In `tests/model/cards.test.ts`, update the two `toEqual` object assertions to include the new fields. The prose test becomes:
```ts
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      sourceKind: null, origin: null, text: 'a point I wrote',
      comments: [], mergedInto: null,
    })
```
(The source-card test asserts individual fields and needs no change, but add `expect(s.comments).toEqual([])` and `expect(s.mergedInto).toBeNull()` to it.)

- [ ] **Step 6: Run the model tests**

Run: `npm test -- tests/model/`
Expected: PASS — `comments.test.ts` and `cards.test.ts` all green.

- [ ] **Step 7: Commit**

```bash
git add src/model tests/model
git commit -m "feat: comment model + card comments[]/mergedInto props"
```

---

### Task 2: Change-set types, guards, and merge plan (pure)

**Files:**
- Create: `src/model/changeset.ts`, `tests/model/changeset.test.ts`

**Interfaces:**
- Consumes: `CommentType` from `src/model/types`.
- Produces:
  - `type Op = { kind: 'add_comment'; cardId: string; comment: { type: CommentType | null; text: string } } | { kind: 'merge_sources'; cardIds: string[] } | { kind: 'move_cards'; moves: { cardId: string; x: number; y: number }[] }`
  - `interface ChangeSet { id: string; author: 'claude'; ops: Op[] }`
  - `isChangeSet(value: unknown): value is ChangeSet`
  - `interface MergePlan { representativeId: string; hiddenIds: string[] }`
  - `planMerge(cardIds: string[]): MergePlan` — representative = `cardIds[0]`; hidden = the rest, de-duplicated, excluding the representative.

- [ ] **Step 1: Write the failing test**

`tests/model/changeset.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { isChangeSet, planMerge } from '../../src/model/changeset'

describe('planMerge', () => {
  test('first card is the representative, the rest are hidden', () => {
    expect(planMerge(['a', 'b', 'c'])).toEqual({ representativeId: 'a', hiddenIds: ['b', 'c'] })
  })
  test('deduplicates and never hides the representative', () => {
    expect(planMerge(['a', 'b', 'b', 'a'])).toEqual({ representativeId: 'a', hiddenIds: ['b'] })
  })
})

describe('isChangeSet', () => {
  test('accepts a well-formed change-set', () => {
    const cs = {
      id: 'x', author: 'claude',
      ops: [
        { kind: 'add_comment', cardId: 'card1', comment: { type: 'needs-evidence', text: 'hi' } },
        { kind: 'merge_sources', cardIds: ['a', 'b'] },
        { kind: 'move_cards', moves: [{ cardId: 'a', x: 10, y: 20 }] },
      ],
    }
    expect(isChangeSet(cs)).toBe(true)
  })
  test('rejects unknown op kinds and malformed shapes', () => {
    expect(isChangeSet({ id: 'x', author: 'claude', ops: [{ kind: 'edit_text', cardId: 'a' }] })).toBe(false)
    expect(isChangeSet({ id: 'x', author: 'claude', ops: 'nope' })).toBe(false)
    expect(isChangeSet(null)).toBe(false)
    expect(isChangeSet({ id: 'x', ops: [] })).toBe(false) // missing author
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/model/changeset.test.ts`
Expected: FAIL — cannot find module `../../src/model/changeset`.

- [ ] **Step 3: Implement**

`src/model/changeset.ts`:
```ts
import { CommentType } from './types'

export type Op =
  | { kind: 'add_comment'; cardId: string; comment: { type: CommentType | null; text: string } }
  | { kind: 'merge_sources'; cardIds: string[] }
  | { kind: 'move_cards'; moves: { cardId: string; x: number; y: number }[] }

export interface ChangeSet {
  id: string
  author: 'claude'
  ops: Op[]
}

const COMMENT_TYPES: readonly (CommentType | null)[] = [
  'needs-evidence', 'weak-argument', 'needs-citation', null,
]

function isOp(v: unknown): v is Op {
  if (typeof v !== 'object' || v === null) return false
  const op = v as Record<string, unknown>
  switch (op.kind) {
    case 'add_comment': {
      const c = op.comment as Record<string, unknown> | undefined
      return typeof op.cardId === 'string' && !!c &&
        typeof c.text === 'string' && COMMENT_TYPES.includes(c.type as CommentType | null)
    }
    case 'merge_sources':
      return Array.isArray(op.cardIds) && op.cardIds.every((id) => typeof id === 'string')
    case 'move_cards':
      return Array.isArray(op.moves) && op.moves.every((m) => {
        const mm = m as Record<string, unknown>
        return typeof mm.cardId === 'string' && typeof mm.x === 'number' && typeof mm.y === 'number'
      })
    default:
      return false
  }
}

export function isChangeSet(value: unknown): value is ChangeSet {
  if (typeof value !== 'object' || value === null) return false
  const cs = value as Record<string, unknown>
  return typeof cs.id === 'string' && cs.author === 'claude' &&
    Array.isArray(cs.ops) && cs.ops.every(isOp)
}

export interface MergePlan {
  representativeId: string
  hiddenIds: string[]
}

export function planMerge(cardIds: string[]): MergePlan {
  const representativeId = cardIds[0]
  const hiddenIds = [...new Set(cardIds.slice(1))].filter((id) => id !== representativeId)
  return { representativeId, hiddenIds }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/model/changeset.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/model/changeset.ts tests/model/changeset.test.ts
git commit -m "feat: change-set types, validation, and merge plan"
```

---

### Task 3: Card shape props + migration

**Files:**
- Modify: `src/shapes/CardShapeUtil.tsx`
- Create: `tests/shapes/migration.test.ts`

**Interfaces:**
- Consumes: `CardShape` props now include `comments: Comment[]` and `mergedInto: string | null` (Task 1 types).
- Produces:
  - `CardShape` type + `CardShapeUtil.props` validators cover `comments` and `mergedInto`.
  - `export function addCommentsUp(props: Record<string, unknown>): void` — the pure migration step (adds `comments: []`, `mergedInto: null`).
  - `CardShapeUtil` has `static override migrations` wiring `addCommentsUp` so pre-Phase-2 snapshots load.

> Verify the tldraw v3 migration + validator API (see the API note at the top) before writing this task.

- [ ] **Step 1: Write the failing migration test**

`tests/shapes/migration.test.ts`:
```ts
import { expect, test } from 'vitest'
import { addCommentsUp } from '../../src/shapes/CardShapeUtil'

test('migration adds comments[] and mergedInto to a pre-Phase-2 card', () => {
  const oldProps: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi',
  }
  addCommentsUp(oldProps)
  expect(oldProps.comments).toEqual([])
  expect(oldProps.mergedInto).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/shapes/migration.test.ts`
Expected: FAIL — `addCommentsUp` is not exported from `CardShapeUtil`.

- [ ] **Step 3: Extend the shape — types, validators, migration**

In `src/shapes/CardShapeUtil.tsx`:

Update the imports to add the migration + validator helpers (verify names against installed tldraw):
```tsx
import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, T, RecordProps,
  createShapePropsMigrationSequence, createShapePropsMigrationIds,
  type Geometry2d,
} from 'tldraw'
import type { CardKind, SourceKind, Origin, Comment } from '../model/types'
```

Extend the `CardShape` props type to include:
```tsx
  comments: Comment[]
  mergedInto: string | null
```

Extend `static override props` with the validators:
```tsx
    comments: T.arrayOf(
      T.object({
        id: T.string,
        type: T.nullable(T.literalEnum('needs-evidence', 'weak-argument', 'needs-citation')),
        text: T.string,
        resolved: T.boolean,
        author: T.literalEnum('claude'),
      }),
    ),
    mergedInto: T.nullable(T.string),
```

Add the migration (above or below the class), exporting the pure step for testing:
```tsx
export function addCommentsUp(props: Record<string, unknown>): void {
  props.comments = []
  props.mergedInto = null
}

const cardVersions = createShapePropsMigrationIds('card', { AddComments: 1 })

export const cardMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: cardVersions.AddComments,
      up: (props) => addCommentsUp(props as Record<string, unknown>),
      down: (props) => {
        const p = props as Record<string, unknown>
        delete p.comments
        delete p.mergedInto
      },
    },
  ],
})
```

Reference the migration on the util:
```tsx
  static override migrations = cardMigrations
```

`getDefaultProps` already delegates to `makeProseCardProps()`, which now returns the new fields — no change needed there.

- [ ] **Step 4: Run the migration test**

Run: `npm test -- tests/shapes/migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression-check the app still loads and creates cards**

The props/migration change is exactly the kind that can break card loading. Confirm the existing Phase 1 e2e still passes:

Run: `rm -f .e2e/canvas.json && npm run e2e`
Expected: PASS — all existing Playwright tests (smoke + cards create/edit/persist) green with the new props defaulted in.

- [ ] **Step 6: Commit**

```bash
git add src/shapes/CardShapeUtil.tsx tests/shapes/migration.test.ts
git commit -m "feat: card shape comments/mergedInto props + migration"
```

---

### Task 4: Server — websocket broadcast + `POST /changeset`

**Files:**
- Create: `server/realtime.ts`, `tests/server/changeset.test.ts`
- Modify: `server/app.ts`, `server/index.ts`, `package.json` (add `ws`)

**Interfaces:**
- Consumes: `isChangeSet`, `ChangeSet` from `src/model/changeset`.
- Produces:
  - `createServer(dataPath: string, onChangeSet?: (cs: ChangeSet) => void)` — adds `POST /changeset` that validates with `isChangeSet`, calls `onChangeSet` and returns `200 { ok: true }`; invalid body → `400 { error }`.
  - `attachRealtime(httpServer: http.Server): { broadcast: (cs: ChangeSet) => void; wss: WebSocketServer }` — a websocket server on path `/ws` that broadcasts change-sets to all connected clients.
  - `index.ts` wires an `http.Server` + `attachRealtime` + `createServer(dataPath, broadcast)`.

- [ ] **Step 1: Add the `ws` dependency**

Run: `npm install ws && npm install -D @types/ws`

- [ ] **Step 2: Write the failing tests**

`tests/server/changeset.test.ts`:
```ts
import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { WebSocket } from 'ws'
import request from 'supertest'
import { createServer } from '../../server/app'
import { attachRealtime } from '../../server/realtime'

let dirs: string[] = []
async function tmpCanvas() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-cs-'))
  dirs.push(d)
  return join(d, 'canvas.json')
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

const validCs = { id: 'x', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: 'a', x: 1, y: 2 }] }] }

test('POST /changeset validates and forwards to onChangeSet', async () => {
  const onChangeSet = vi.fn()
  const app = createServer(await tmpCanvas(), onChangeSet)
  const ok = await request(app).post('/changeset').send(validCs)
  expect(ok.status).toBe(200)
  expect(onChangeSet).toHaveBeenCalledWith(validCs)

  const bad = await request(app).post('/changeset').send({ id: 'x', ops: 'nope' })
  expect(bad.status).toBe(400)
})

test('attachRealtime broadcasts a change-set to connected websocket clients', async () => {
  const server = http.createServer()
  const { broadcast } = attachRealtime(server)
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as import('node:net').AddressInfo

  const ws = new WebSocket(`ws://localhost:${port}/ws`)
  const received = new Promise<any>((resolve) => ws.on('message', (d) => resolve(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  broadcast(validCs as any)
  expect(await received).toEqual(validCs)

  ws.close()
  await new Promise<void>((r) => server.close(() => r()))
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- tests/server/changeset.test.ts`
Expected: FAIL — `../../server/realtime` missing, and `createServer` has no `/changeset`.

- [ ] **Step 4: Implement the realtime module**

`server/realtime.ts`:
```ts
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ChangeSet } from '../src/model/changeset'

export function attachRealtime(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
  })

  function broadcast(changeSet: ChangeSet) {
    const msg = JSON.stringify(changeSet)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  return { broadcast, wss }
}
```

- [ ] **Step 5: Add `POST /changeset` to the app**

In `server/app.ts`, import the guard and accept an optional callback:
```ts
import { isChangeSet, ChangeSet } from '../src/model/changeset'
```
Change the signature and add the route (keep the existing `/canvas` routes):
```ts
export function createServer(dataPath: string, onChangeSet?: (cs: ChangeSet) => void) {
  // ... existing app setup and /canvas routes ...

  app.post('/changeset', (req, res) => {
    if (!isChangeSet(req.body)) {
      res.status(400).json({ error: 'invalid change-set' })
      return
    }
    onChangeSet?.(req.body)
    res.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 6: Wire the entrypoint**

Replace `server/index.ts` with a version that shares one http server between Express and the websocket:
```ts
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'
import { attachRealtime } from './realtime'

const here = dirname(fileURLToPath(import.meta.url))
const dataPath = process.env.ELVES_CANVAS ?? join(here, '..', 'data', 'canvas.json')
const port = Number(process.env.PORT ?? 5199)

const httpServer = http.createServer()
const { broadcast } = attachRealtime(httpServer)
const app = createServer(dataPath, broadcast)
httpServer.on('request', app)

httpServer.listen(port, () => {
  console.log(`Elves server on http://localhost:${port}  (canvas: ${dataPath})`)
})
```

- [ ] **Step 7: Run the tests + boot check**

Run: `npm test -- tests/server/` (all server tests green) and `npm run start` (logs the listen line, then stop it).
Expected: server tests PASS; server boots.

- [ ] **Step 8: Commit**

```bash
git add server tests/server/changeset.test.ts package.json package-lock.json
git commit -m "feat: server websocket + POST /changeset broadcast"
```

---

### Task 5: App — realtime client, applier, comment rendering + resolve

**Files:**
- Create: `src/apply/applyChangeSet.ts`, `src/client/realtime.ts`, `e2e/comments.spec.ts`
- Modify: `src/App.tsx`, `src/shapes/CardShapeUtil.tsx`, `src/shapes/card.css`

**Interfaces:**
- Consumes: `ChangeSet`, `Op` (`src/model/changeset`); `makeComment`, `addComment`, `resolveComment`, `visibleComments` (`src/model/comments`); `CardShape` (`src/shapes/CardShapeUtil`).
- Produces:
  - `applyChangeSet(editor: Editor, cs: ChangeSet): void` — applies the whole set in one undo step. In this task it handles `add_comment`; Task 6 adds `merge_sources`/`move_cards`.
  - `connectRealtime(onChangeSet: (cs: ChangeSet) => void): () => void` — opens a browser `WebSocket` to `/ws` and calls back on each message; returns a disposer.
  - Card component renders `visibleComments` as color-coded Claude pins with a resolve (×) control.

> Verify `editor.run` / `editor.markHistoryStoppingPoint` / `editor.getShape` / `editor.updateShape` against installed tldraw before writing.

- [ ] **Step 1: Write the failing e2e test**

`e2e/comments.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

async function firstCardId(request: any): Promise<string> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  const card: any = records.find((r: any) => r.typeName === 'shape' && r.type === 'card')
  return card.id
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('an injected comment renders on the card, then resolves away', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()
  await page.waitForTimeout(800) // let the card persist so we can read its id

  const cardId = await firstCardId(request)
  await request.post(`${BASE}/changeset`, {
    data: { id: 'cs1', author: 'claude', ops: [
      { kind: 'add_comment', cardId, comment: { type: 'needs-evidence', text: 'no source yet' } },
    ] },
  })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('no source yet')

  // one Ctrl-Z reverts Claude's change
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-comment')).toHaveCount(0)

  // re-inject and resolve instead
  await request.post(`${BASE}/changeset`, {
    data: { id: 'cs2', author: 'claude', ops: [
      { kind: 'add_comment', cardId, comment: { type: null, text: 'freeform note' } },
    ] },
  })
  await expect(page.locator('.elves-comment')).toHaveCount(1)
  await page.getByTestId('comment-resolve').first().click()
  await expect(page.locator('.elves-comment')).toHaveCount(0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/comments.spec.ts`
Expected: FAIL — no realtime client / applier / comment rendering yet.

- [ ] **Step 3: Implement the applier (add_comment)**

`src/apply/applyChangeSet.ts`:
```ts
import { Editor } from 'tldraw'
import { ChangeSet, Op } from '../model/changeset'
import { CardShape } from '../shapes/CardShapeUtil'
import { makeComment, addComment } from '../model/comments'

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function applyAddComment(editor: Editor, op: Extract<Op, { kind: 'add_comment' }>): void {
  const shape = editor.getShape(op.cardId as CardShape['id']) as CardShape | undefined
  if (!shape) return
  const comment = makeComment(newId('cmt'), op.comment.text, op.comment.type)
  editor.updateShape<CardShape>({
    id: shape.id, type: 'card',
    props: { comments: addComment(shape.props.comments, comment) },
  })
}

function applyOp(editor: Editor, op: Op): void {
  switch (op.kind) {
    case 'add_comment':
      applyAddComment(editor, op)
      break
    // merge_sources / move_cards added in Task 6
  }
}

export function applyChangeSet(editor: Editor, cs: ChangeSet): void {
  editor.markHistoryStoppingPoint(`claude:${cs.id}`)
  editor.run(() => {
    for (const op of cs.ops) applyOp(editor, op)
  })
}
```

- [ ] **Step 4: Implement the realtime client**

`src/client/realtime.ts`:
```ts
import { ChangeSet } from '../model/changeset'

const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export function connectRealtime(onChangeSet: (cs: ChangeSet) => void): () => void {
  const url = BASE.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(url)
  ws.onmessage = (e) => {
    try {
      onChangeSet(JSON.parse(e.data))
    } catch (err) {
      console.error('Elves: bad change-set message', err)
    }
  }
  ws.onerror = (err) => console.error('Elves: realtime socket error', err)
  return () => ws.close()
}
```

- [ ] **Step 5: Wire realtime into the app**

In `src/App.tsx`, import the pieces and connect on mount (inside `handleMount`, after the store listener is attached):
```tsx
import { applyChangeSet } from './apply/applyChangeSet'
import { connectRealtime } from './client/realtime'
```
Add to the end of the `.finally(...)` block in `handleMount`:
```tsx
        connectRealtime((cs) => applyChangeSet(ed, cs))
```

- [ ] **Step 6: Render comments on the card**

In `src/shapes/CardShapeUtil.tsx`, import the helper:
```tsx
import { visibleComments, resolveComment } from '../model/comments'
```
In `component(shape)`, compute visible comments and render them below the text block (inside the `.elves-card` div, after the text/editor):
```tsx
        {visibleComments(shape.props.comments).length > 0 && (
          <div className="elves-comments">
            {visibleComments(shape.props.comments).map((c) => (
              <div
                key={c.id}
                className="elves-comment"
                data-type={c.type ?? 'freeform'}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {c.type && <span className="elves-comment__type">{c.type}</span>}
                <span className="elves-comment__text">{c.text}</span>
                <button
                  className="elves-comment__resolve"
                  data-testid="comment-resolve"
                  onClick={() =>
                    this.editor.updateShape<CardShape>({
                      id: shape.id, type: 'card',
                      props: { comments: resolveComment(shape.props.comments, c.id) },
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 7: Style the comment pins**

Append to `src/shapes/card.css`:
```css
.elves-comments { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.elves-comment {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 1.3;
  padding: 4px 6px; border-radius: 6px;
  background: #f3eefb; color: #4a3c66;
  border-left: 3px solid #8b6fc7;
}
.elves-comment[data-type="needs-evidence"] { background: #fdeeec; color: #7a3b2e; border-left-color: #d0674f; }
.elves-comment[data-type="weak-argument"]  { background: #fdf5e6; color: #7a5a1e; border-left-color: #d09b34; }
.elves-comment[data-type="needs-citation"] { background: #eaf3fb; color: #2f4d6b; border-left-color: #4f8bd0; }
.elves-comment__type { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.03em; }
.elves-comment__text { flex: 1; }
.elves-comment__resolve {
  border: none; background: transparent; cursor: pointer;
  font-size: 14px; line-height: 1; color: inherit; opacity: 0.6;
}
.elves-comment__resolve:hover { opacity: 1; }
```

- [ ] **Step 8: Run the e2e test to verify it passes**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/comments.spec.ts`
Expected: PASS — comment renders, one Ctrl‑Z removes it, resolve hides it.

- [ ] **Step 9: Run the full unit suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all unit tests pass; `tsc --noEmit` clean.

- [ ] **Step 10: Commit**

```bash
git add src e2e/comments.spec.ts
git commit -m "feat: realtime change-set client + applier + comment rendering/resolve"
```

---

### Task 6: App — merge and move ops + hidden-merged rendering

**Files:**
- Modify: `src/apply/applyChangeSet.ts`, `src/shapes/CardShapeUtil.tsx`, `src/shapes/card.css`
- Create: `e2e/changes.spec.ts`

**Interfaces:**
- Consumes: `planMerge` (`src/model/changeset`); `CardShape`; the existing `applyChangeSet` from Task 5.
- Produces: `applyChangeSet` now also handles `merge_sources` (sets `mergedInto` on the non-representative source cards) and `move_cards` (sets `x`/`y`). Cards with `mergedInto` set render hidden; the representative shows a "N merged" badge.

- [ ] **Step 1: Write the failing e2e test**

`e2e/changes.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

async function cardIds(request: any): Promise<string[]> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records.filter((r: any) => r.typeName === 'shape' && r.type === 'card').map((r: any) => r.id)
}
async function cardById(request: any, id: string): Promise<any> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records.find((r: any) => r.id === id)
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('move_cards repositions a card and one Ctrl-Z reverts it', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-source').click()
  await page.waitForTimeout(800)
  const [id] = await cardIds(request)
  const before = await cardById(request, id)

  await request.post(`${BASE}/changeset`, {
    data: { id: 'm1', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: id, x: before.x + 500, y: before.y }] }] },
  })
  await page.waitForTimeout(800)
  expect((await cardById(request, id)).x).toBeCloseTo(before.x + 500, 0)

  await page.keyboard.press('Control+z')
  await page.waitForTimeout(800)
  expect((await cardById(request, id)).x).toBeCloseTo(before.x, 0)
})

test('merge_sources hides duplicates under the representative and marks provenance', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-source').click()
  await page.getByTestId('new-source').click()
  await page.waitForTimeout(800)
  const ids = await cardIds(request)
  expect(ids.length).toBe(2)

  await request.post(`${BASE}/changeset`, {
    data: { id: 'mg1', author: 'claude', ops: [{ kind: 'merge_sources', cardIds: ids }] },
  })

  // representative shows the merged badge; exactly one visible source card remains
  await expect(page.getByTestId('merged-badge')).toBeVisible()
  await expect(page.locator('.elves-card--source:visible')).toHaveCount(1)
  expect((await cardById(request, ids[1])).props.mergedInto).toBe(ids[0])

  // Ctrl-Z restores the duplicate
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('merged-badge')).toHaveCount(0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/changes.spec.ts`
Expected: FAIL — merge/move not applied; no merged-badge / hidden rendering.

- [ ] **Step 3: Implement merge and move in the applier**

In `src/apply/applyChangeSet.ts`, import `planMerge`:
```ts
import { ChangeSet, Op, planMerge } from '../model/changeset'
```
Add the two handlers and wire them into `applyOp`:
```ts
function applyMerge(editor: Editor, op: Extract<Op, { kind: 'merge_sources' }>): void {
  const { representativeId, hiddenIds } = planMerge(op.cardIds)
  for (const id of hiddenIds) {
    const shape = editor.getShape(id as CardShape['id']) as CardShape | undefined
    if (shape && shape.props.kind === 'source') {
      editor.updateShape<CardShape>({ id: shape.id, type: 'card', props: { mergedInto: representativeId } })
    }
  }
}

function applyMove(editor: Editor, op: Extract<Op, { kind: 'move_cards' }>): void {
  for (const m of op.moves) {
    const shape = editor.getShape(m.cardId as CardShape['id'])
    if (shape) editor.updateShape({ id: shape.id, type: 'card', x: m.x, y: m.y })
  }
}
```
Extend the `switch` in `applyOp`:
```ts
    case 'merge_sources':
      applyMerge(editor, op)
      break
    case 'move_cards':
      applyMove(editor, op)
      break
```

- [ ] **Step 4: Render hidden-merged cards and the representative badge**

In `src/shapes/CardShapeUtil.tsx`, at the very top of `component(shape)`, hide merged-away cards:
```tsx
  component(shape: CardShape) {
    if (shape.props.mergedInto) {
      // Merged into a representative — hidden but recoverable.
      return <HTMLContainer />
    }
    const mergedCount = this.editor
      .getCurrentPageShapes()
      .filter((s) => s.type === 'card' && (s as CardShape).props.mergedInto === shape.id).length
    // ...existing const destructuring and return follow; add the badge inside .elves-card:
```
Inside the `.elves-card` div (e.g. near the source badge), add:
```tsx
        {mergedCount > 0 && (
          <span className="elves-merged" data-testid="merged-badge">⊕ {mergedCount} merged</span>
        )}
```

- [ ] **Step 5: Style the merged badge**

Append to `src/shapes/card.css`:
```css
.elves-merged {
  align-self: flex-start;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: #e5e0f5;
  color: #4a3c66;
}
```

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/changes.spec.ts`
Expected: PASS — move repositions + reverts; merge hides the duplicate under a badge + reverts.

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npm run typecheck && rm -f .e2e/canvas.json && npm run e2e`
Expected: all unit tests, `tsc --noEmit`, and all Playwright specs green.

- [ ] **Step 8: Commit**

```bash
git add src e2e/changes.spec.ts
git commit -m "feat: merge + move change-set ops with hidden-merged rendering"
```

---

## Phase 2a Definition of Done
- Posting a change-set to `/changeset` applies it live in the open app: comments appear (color-coded by type) and resolve/dismiss away; duplicate source cards collapse under a representative with a "N merged" badge; cards move.
- Each change-set is undone by a single Ctrl‑Z.
- Everything persists across reload; existing Phase 1 canvases still load (migration).
- `npm test`, `npm run typecheck`, and `npm run e2e` are all green.
- No code path writes a card's `text` in response to a change-set.

## Self-Review (done during authoring)
- **Spec coverage:** comments model + typed/freeform + resolve-hidden-recoverable (§6) → Tasks 1, 5; comments as card prop + migration (§6, §10) → Tasks 1, 3; change-set schema + ops (§5, §10) → Task 2; merge = collapse under `cardIds[0]`, source-only, recoverable (§7) → Tasks 2, 6; reorder/cluster via `move_cards` on the x-axis (§4, §8) → Task 6; Approach-1 architecture — MCP-less relay via websocket + single-undo applier (§9) → Tasks 4, 5, 6; "no op writes card text" (§3, §5) → applier handles only comment/merge/move; test-harness-driven, no Claude (§12) → `POST /changeset` + e2e injection. Deferred items (tags, links, `create_source_card`, images, Tana, MDX) are correctly absent.
- **Placeholder scan:** none; every code/test step is complete.
- **Type consistency:** `Comment`/`CommentType` identical across `types.ts` (Task 1), the shape validators (Task 3), and rendering (Task 5); `Op`/`ChangeSet`/`planMerge` signatures consistent across Tasks 2, 4, 5, 6; `createServer(dataPath, onChangeSet?)` matches its test and `index.ts` use; `applyChangeSet(editor, cs)`/`connectRealtime(onChangeSet)` consistent across App and e2e.
