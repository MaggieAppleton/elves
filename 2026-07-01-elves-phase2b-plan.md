# Elves Phase 2b (Claude Connected) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Claude to the Elves canvas through a **scoped MCP server** whose four tools — `read_canvas`, `add_comment`, `merge_sources`, `move_cards` — are the capability boundary: Claude reads a clean card digest and emits change-sets (which flow through Phase 2a's `/changeset` machinery to the open app), but has no tool that can write a card's text.

**Architecture:** The Elves HTTP server gains a `GET /cards` endpoint returning a clean **card digest** (a projection of the tldraw snapshot) and a defense-in-depth guard rejecting any change-set that would write card text. A separate **stdio MCP server** (`mcp/`) that Claude Code launches acts as a thin client of the Elves HTTP server: `read_canvas` → `GET /cards`; the three mutation tools build an `author:'claude'` change-set and `POST /changeset`. The open app applies and persists it (Phase 2a). A Claude skill teaches the boundary, the x-axis convention, and when to use each tool.

**Tech Stack:** TypeScript, Node (built-in `fetch`), `@modelcontextprotocol/sdk`, `zod`, Express, `ws`, tldraw v3, Vitest, Playwright.

## Global Constraints

Copied from the Phase 2 spec; every task inherits these.

- **The MCP tool list IS the capability boundary.** Exactly four tools: `read_canvas`, `add_comment`, `merge_sources`, `move_cards`. There is **no tool that edits card text** — not prose, not source.
- **Mutations flow through Phase 2a's `/changeset`** endpoint (validated by `isChangeSet`); the open app applies + persists them. The MCP server never writes files or the tldraw store directly.
- **Defense-in-depth:** the server rejects any change-set for which `changeSetWritesText(cs)` is true (always false for the current op vocabulary — this is the encoded invariant the spec calls for).
- **`read_canvas` returns a clean card digest**, not the raw tldraw snapshot: `{ id, kind, sourceKind, origin, text, x, y, comments, mergedInto }` per card.
- **Change-sets are `{ id, author: 'claude', ops }`**; the MCP server sets `author: 'claude'` and a fresh `id`.
- **x-axis = narrative order** (left = earlier, right = later) — the skill teaches Claude to reason about ordering as x-position and to reorder via `move_cards`.
- Local-first, single device, turn-based; the app must be open for a change to land.
- Claude may comment / dedupe / reorder — **never write your prose.**

## Project Layout (added/changed by this plan)

```
server/
  digest.ts       # snapshotToCards(snapshot) -> CardDigest[]                  (Task 1)
  app.ts          # + GET /cards; + changeSetWritesText guard on /changeset    (Task 1)
src/model/
  changeset.ts    # + changeSetWritesText(cs)                                  (Task 1)
mcp/
  elvesClient.ts  # readCards(baseUrl), postChangeSet(baseUrl, cs)             (Task 2)
  tools.ts        # makeChangeSet + tool handler functions (baseUrl-injected)  (Task 2)
  index.ts        # McpServer: register 4 tools, stdio transport               (Task 3)
skill/
  elves-canvas.md # the Claude skill (boundary, x-axis, when-to-use)           (Task 4)
.mcp.json         # Claude Code MCP server registration                        (Task 4)
tests/
  server/digest.test.ts        (Task 1)
  model/guard.test.ts          (Task 1)
  mcp/tools.test.ts            (Task 2)
  mcp/server.test.ts           (Task 3)
e2e/
  claude-tools.spec.ts         (Task 4)
```

> **API verification note:** Task 1 reads the tldraw snapshot shape (`document.store`); Tasks 3–4 use `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`, `InMemoryTransport`, `Client`, `server.tool(...)`). Verify both against the installed versions via context7 (`resolve-library-id` → `modelcontextprotocol` / `tldraw`, then `query-docs`) before writing those tasks; the run-test steps will surface drift. If the SDK's tool-registration signature differs, adapt minimally to register the four named tools with the given input schemas and handlers.

---

### Task 1: Server — card digest (`GET /cards`) + text-safety guard

**Files:**
- Create: `server/digest.ts`, `tests/server/digest.test.ts`, `tests/model/guard.test.ts`
- Modify: `src/model/changeset.ts`, `server/app.ts`

**Interfaces:**
- Consumes: `readCanvas`/`CanvasSnapshot` (`server/store`); `isChangeSet`/`ChangeSet`/`Op` (`src/model/changeset`); `CardKind`/`SourceKind`/`Origin`/`Comment` (`src/model/types`).
- Produces:
  - `interface CardDigest { id: string; kind: CardKind; sourceKind: SourceKind | null; origin: Origin | null; text: string; x: number; y: number; comments: Comment[]; mergedInto: string | null }`
  - `snapshotToCards(snapshot: CanvasSnapshot): CardDigest[]`
  - `GET /cards` → `200 CardDigest[]`
  - `changeSetWritesText(cs: ChangeSet): boolean` (in `src/model/changeset`) — true iff any op would write a card's text; **always false** for `add_comment`/`merge_sources`/`move_cards`.
  - `POST /changeset` additionally returns `403 { error }` when `changeSetWritesText(cs)` is true.

- [ ] **Step 1: Write the failing digest test**

`tests/server/digest.test.ts`:
```ts
import { expect, test } from 'vitest'
import { snapshotToCards } from '../../server/digest'

test('snapshotToCards projects card shapes into a clean digest', () => {
  const snapshot = {
    document: {
      store: {
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 10, y: 20,
          props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'my point', comments: [], mergedInto: null },
        },
        'shape:b': {
          id: 'shape:b', typeName: 'shape', type: 'geo', x: 0, y: 0, props: {},
        },
        'page:p': { id: 'page:p', typeName: 'page' },
      },
    },
    session: null,
  }
  expect(snapshotToCards(snapshot)).toEqual([
    { id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'my point', x: 10, y: 20, comments: [], mergedInto: null },
  ])
})

test('snapshotToCards returns [] for an empty canvas', () => {
  expect(snapshotToCards({ document: null, session: null })).toEqual([])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/server/digest.test.ts`
Expected: FAIL — cannot find module `../../server/digest`.

- [ ] **Step 3: Implement the digest**

`server/digest.ts`:
```ts
import type { CanvasSnapshot } from './store'
import type { CardKind, SourceKind, Origin, Comment } from '../src/model/types'

export interface CardDigest {
  id: string
  kind: CardKind
  sourceKind: SourceKind | null
  origin: Origin | null
  text: string
  x: number
  y: number
  comments: Comment[]
  mergedInto: string | null
}

export function snapshotToCards(snapshot: CanvasSnapshot): CardDigest[] {
  const doc = (snapshot?.document ?? null) as { store?: Record<string, any>; records?: Record<string, any> } | null
  if (!doc) return []
  const store = doc.store ?? doc.records ?? {}
  return Object.values(store)
    .filter((r: any) => r && r.typeName === 'shape' && r.type === 'card')
    .map((r: any) => ({
      id: r.id,
      kind: r.props.kind,
      sourceKind: r.props.sourceKind ?? null,
      origin: r.props.origin ?? null,
      text: r.props.text ?? '',
      x: r.x,
      y: r.y,
      comments: r.props.comments ?? [],
      mergedInto: r.props.mergedInto ?? null,
    }))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/server/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing guard test**

`tests/model/guard.test.ts`:
```ts
import { expect, test } from 'vitest'
import { changeSetWritesText } from '../../src/model/changeset'

test('none of the Phase 2 ops write card text', () => {
  const cs = {
    id: 'x', author: 'claude' as const,
    ops: [
      { kind: 'add_comment' as const, cardId: 'a', comment: { type: null, text: 'note' } },
      { kind: 'merge_sources' as const, cardIds: ['a', 'b'] },
      { kind: 'move_cards' as const, moves: [{ cardId: 'a', x: 1, y: 2 }] },
    ],
  }
  expect(changeSetWritesText(cs)).toBe(false)
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- tests/model/guard.test.ts`
Expected: FAIL — `changeSetWritesText` not exported.

- [ ] **Step 7: Implement the guard**

Append to `src/model/changeset.ts`:
```ts
/**
 * Defense-in-depth for the core rule "Claude never writes prose". Returns true
 * iff any op in the change-set would write a card's text. The current op
 * vocabulary (add_comment / merge_sources / move_cards) has no such op, so this
 * is always false — but the server calls it before applying, so if a text-writing
 * op is ever added it must be added here consciously.
 */
export function changeSetWritesText(cs: ChangeSet): boolean {
  return cs.ops.some((op) => {
    switch (op.kind) {
      case 'add_comment':
      case 'merge_sources':
      case 'move_cards':
        return false
      default:
        return true // unknown op: treat as unsafe
    }
  })
}
```

- [ ] **Step 8: Write the failing endpoint/guard tests**

Append to `tests/server/changeset.test.ts` (the file created in Phase 2a — add two tests inside it):
```ts
import { snapshotToCards } from '../../server/digest'

test('GET /cards returns the card digest', async () => {
  const app = createServer(await tmpCanvas())
  const snap = {
    document: { store: { 'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 5, y: 6, props: { w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'raw', comments: [], mergedInto: null } } } },
    session: null,
  }
  await request(app).post('/canvas').send(snap)
  const res = await request(app).get('/cards')
  expect(res.status).toBe(200)
  expect(res.body).toEqual(snapshotToCards(snap))
})

test('POST /changeset rejects a change-set that would write text (403)', async () => {
  const app = createServer(await tmpCanvas())
  const bad = { id: 'x', author: 'claude', ops: [{ kind: 'edit_text', cardId: 'a', text: 'no' }] }
  const res = await request(app).post('/changeset').send(bad)
  expect(res.status).toBe(400) // isChangeSet already rejects unknown kinds first
})
```

> Note: `isChangeSet` (Phase 2a) rejects unknown op kinds with 400 before the guard runs, so a smuggled `edit_text` op is caught at validation. The guard is the second layer for any *future* op that passes validation. This test documents the current 400 behavior; the guard's own coverage is the unit test in Step 5.

- [ ] **Step 9: Add `GET /cards` and the guard to the app**

In `server/app.ts`, add imports:
```ts
import { snapshotToCards } from './digest'
import { isChangeSet, ChangeSet, changeSetWritesText } from '../src/model/changeset'
```
Add the `GET /cards` route (near the `/canvas` routes):
```ts
  app.get('/cards', async (_req, res) => {
    res.json(snapshotToCards(await readCanvas(dataPath)))
  })
```
And in the existing `POST /changeset` handler, after the `isChangeSet` check, add the guard before calling `onChangeSet`:
```ts
    if (changeSetWritesText(req.body)) {
      res.status(403).json({ error: 'change-set may not write card text' })
      return
    }
```

- [ ] **Step 10: Run the server + model tests**

Run: `npm test -- tests/server/ tests/model/`
Expected: PASS — digest, guard, and the new endpoint tests green; existing tests unaffected.

- [ ] **Step 11: Commit**

```bash
git add server/digest.ts src/model/changeset.ts server/app.ts tests/server/digest.test.ts tests/server/changeset.test.ts tests/model/guard.test.ts
git commit -m "feat: GET /cards digest + changeSetWritesText guard"
```

---

### Task 2: MCP tool logic — Elves client + change-set builders

**Files:**
- Create: `mcp/elvesClient.ts`, `mcp/tools.ts`, `tests/mcp/tools.test.ts`
- Modify: `tsconfig.json` (add `mcp` to `include`)

**Interfaces:**
- Consumes: `ChangeSet`/`Op` (`src/model/changeset`); `CardDigest` (`server/digest`); `CommentType` (`src/model/types`).
- Produces:
  - `readCards(baseUrl: string): Promise<CardDigest[]>` — `GET {baseUrl}/cards`.
  - `postChangeSet(baseUrl: string, cs: ChangeSet): Promise<void>` — `POST {baseUrl}/changeset`; throws on non-2xx.
  - `makeChangeSet(ops: Op[]): ChangeSet` — `{ id: crypto.randomUUID(), author: 'claude', ops }`.
  - Tool handlers (baseUrl-injected): `readCanvasTool(baseUrl)`, `addCommentTool(baseUrl, { cardId, text, type })`, `mergeSourcesTool(baseUrl, { cardIds })`, `moveCardsTool(baseUrl, { moves })`.

- [ ] **Step 1: Add `mcp` to tsconfig include**

In `tsconfig.json`, change the `include` array to add `"mcp"`:
```json
  "include": ["src", "server", "tests", "mcp"]
```

- [ ] **Step 2: Write the failing tests**

`tests/mcp/tools.test.ts`:
```ts
import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createServer } from '../../server/app'
import { attachRealtime } from '../../server/realtime'
import { makeChangeSet, addCommentTool, moveCardsTool, mergeSourcesTool, readCanvasTool } from '../../mcp/tools'

let servers: http.Server[] = []
async function liveElves(): Promise<string> {
  const httpServer = http.createServer()
  const { broadcast } = attachRealtime(httpServer)
  const app = createServer(process.env.ELVES_CANVAS ?? '/tmp/elves-mcp-test-canvas.json', broadcast)
  httpServer.on('request', app)
  await new Promise<void>((r) => httpServer.listen(0, r))
  servers.push(httpServer)
  const { port } = httpServer.address() as import('node:net').AddressInfo
  return `http://localhost:${port}`
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
})

test('makeChangeSet stamps author claude and a string id', () => {
  const cs = makeChangeSet([{ kind: 'move_cards', moves: [] }])
  expect(cs.author).toBe('claude')
  expect(typeof cs.id).toBe('string')
  expect(cs.ops).toEqual([{ kind: 'move_cards', moves: [] }])
})

test('addCommentTool posts a valid change-set that the server broadcasts', async () => {
  const base = await liveElves()
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws')
  const received = new Promise<any>((res) => ws.on('message', (d) => res(JSON.parse(d.toString()))))
  await new Promise<void>((r) => ws.on('open', () => r()))

  await addCommentTool(base, { cardId: 'shape:a', text: 'no source', type: 'needs-evidence' })

  const cs = await received
  expect(cs.author).toBe('claude')
  expect(cs.ops).toEqual([{ kind: 'add_comment', cardId: 'shape:a', comment: { type: 'needs-evidence', text: 'no source' } }])
  ws.close()
})

test('readCanvasTool reads the card digest', async () => {
  const base = await liveElves()
  const snap = { document: { store: { 'shape:a': { id: 'shape:a', typeName: 'shape', type: 'card', x: 1, y: 2, props: { w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi', comments: [], mergedInto: null } } } }, session: null }
  await fetch(`${base}/canvas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap) })
  const cards = await readCanvasTool(base)
  expect(cards).toEqual([{ id: 'shape:a', kind: 'prose', sourceKind: null, origin: null, text: 'hi', x: 1, y: 2, comments: [], mergedInto: null }])
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- tests/mcp/tools.test.ts`
Expected: FAIL — `../../mcp/tools` / `../../mcp/elvesClient` missing.

- [ ] **Step 4: Implement the Elves client**

`mcp/elvesClient.ts`:
```ts
import type { ChangeSet } from '../src/model/changeset'
import type { CardDigest } from '../server/digest'

export async function readCards(baseUrl: string): Promise<CardDigest[]> {
  const res = await fetch(`${baseUrl}/cards`)
  if (!res.ok) throw new Error(`read_canvas failed: ${res.status}`)
  return res.json() as Promise<CardDigest[]>
}

export async function postChangeSet(baseUrl: string, cs: ChangeSet): Promise<void> {
  const res = await fetch(`${baseUrl}/changeset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cs),
  })
  if (!res.ok) throw new Error(`change-set rejected: ${res.status}`)
}
```

- [ ] **Step 5: Implement the tool handlers**

`mcp/tools.ts`:
```ts
import type { ChangeSet, Op } from '../src/model/changeset'
import type { CommentType } from '../src/model/types'
import type { CardDigest } from '../server/digest'
import { readCards, postChangeSet } from './elvesClient'

export function makeChangeSet(ops: Op[]): ChangeSet {
  return { id: crypto.randomUUID(), author: 'claude', ops }
}

export function readCanvasTool(baseUrl: string): Promise<CardDigest[]> {
  return readCards(baseUrl)
}

export function addCommentTool(
  baseUrl: string,
  args: { cardId: string; text: string; type?: CommentType | null },
): Promise<void> {
  return postChangeSet(baseUrl, makeChangeSet([
    { kind: 'add_comment', cardId: args.cardId, comment: { type: args.type ?? null, text: args.text } },
  ]))
}

export function mergeSourcesTool(baseUrl: string, args: { cardIds: string[] }): Promise<void> {
  return postChangeSet(baseUrl, makeChangeSet([{ kind: 'merge_sources', cardIds: args.cardIds }]))
}

export function moveCardsTool(
  baseUrl: string,
  args: { moves: { cardId: string; x: number; y: number }[] },
): Promise<void> {
  return postChangeSet(baseUrl, makeChangeSet([{ kind: 'move_cards', moves: args.moves }]))
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -- tests/mcp/tools.test.ts`
Expected: PASS — builder + both live-server tests green.

- [ ] **Step 7: Commit**

```bash
git add mcp/elvesClient.ts mcp/tools.ts tests/mcp/tools.test.ts tsconfig.json
git commit -m "feat: MCP tool logic (elves client + change-set builders)"
```

---

### Task 3: MCP server wiring (four tools over stdio)

**Files:**
- Create: `mcp/index.ts`, `tests/mcp/server.test.ts`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`, `zod`, and an `mcp` script)

**Interfaces:**
- Consumes: the tool handlers from `mcp/tools`.
- Produces:
  - `createMcpServer(baseUrl: string): McpServer` — an MCP server registering exactly four tools: `read_canvas`, `add_comment`, `merge_sources`, `move_cards`, with the input schemas below, each handler delegating to the Task 2 tool functions.
  - `mcp/index.ts` connects `createMcpServer(process.env.ELVES_URL ?? 'http://localhost:5199')` to a `StdioServerTransport`.
  - `npm run mcp` runs the server.

> Verify the `@modelcontextprotocol/sdk` API (`McpServer`, `server.tool(...)`/`registerTool`, `StdioServerTransport`, and for the test `InMemoryTransport` + `Client`) via context7 before writing. Adapt the registration calls minimally to the installed signature while keeping the four tool names + schemas.

- [ ] **Step 1: Install the SDK**

Run: `npm install @modelcontextprotocol/sdk zod`

- [ ] **Step 2: Write the failing tool-registration test**

`tests/mcp/server.test.ts`:
```ts
import { expect, test } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpServer } from '../../mcp/index'

test('the MCP server exposes exactly the four scoped tools and no text-editing tool', async () => {
  const server = createMcpServer('http://localhost:5199')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientT)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  expect(names).toEqual(['add_comment', 'merge_sources', 'move_cards', 'read_canvas'])
  expect(names).not.toContain('edit_text')

  await client.close()
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- tests/mcp/server.test.ts`
Expected: FAIL — `createMcpServer` / `mcp/index` missing.

- [ ] **Step 4: Implement the MCP server**

`mcp/index.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readCanvasTool, addCommentTool, mergeSourcesTool, moveCardsTool } from './tools'

const COMMENT_TYPE = z.enum(['needs-evidence', 'weak-argument', 'needs-citation'])

export function createMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'elves', version: '0.1.0' })

  server.tool(
    'read_canvas',
    'Read the current canvas as a list of cards: id, kind (prose|source), text, x/y position (x is narrative order: left=earlier, right=later), comments, and mergedInto. Call this first to get card ids before commenting, merging, or moving.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await readCanvasTool(baseUrl), null, 2) }] }),
  )

  server.tool(
    'add_comment',
    "Attach a comment to a card. Use a typed comment to flag a weakness in the user's PROSE (needs-evidence, weak-argument, needs-citation) or omit type for a freeform note. You never write or edit card text — only comments.",
    { cardId: z.string(), text: z.string(), type: COMMENT_TYPE.nullish() },
    async ({ cardId, text, type }) => {
      await addCommentTool(baseUrl, { cardId, text, type: type ?? null })
      return { content: [{ type: 'text', text: 'comment added' }] }
    },
  )

  server.tool(
    'merge_sources',
    'Collapse duplicate SOURCE cards into one. Pass the card ids to merge; the FIRST id is kept as the representative and the others are hidden (recoverable) under it. Source cards only.',
    { cardIds: z.array(z.string()).min(2) },
    async ({ cardIds }) => {
      await mergeSourcesTool(baseUrl, { cardIds })
      return { content: [{ type: 'text', text: 'sources merged' }] }
    },
  )

  server.tool(
    'move_cards',
    'Reposition cards. x is narrative order (smaller x = earlier in the piece). To bring a point earlier, move it to a smaller x than the points it should precede. Provide absolute x/y for each card.',
    { moves: z.array(z.object({ cardId: z.string(), x: z.number(), y: z.number() })).min(1) },
    async ({ moves }) => {
      await moveCardsTool(baseUrl, { moves })
      return { content: [{ type: 'text', text: 'cards moved' }] }
    },
  )

  return server
}

async function main() {
  const server = createMcpServer(process.env.ELVES_URL ?? 'http://localhost:5199')
  await server.connect(new StdioServerTransport())
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  main().catch((err) => {
    console.error('Elves MCP server failed:', err)
    process.exit(1)
  })
}
```

Add the `mcp` script to `package.json` scripts:
```json
    "mcp": "tsx mcp/index.ts",
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- tests/mcp/server.test.ts`
Expected: PASS — the four tools are registered; `edit_text` is absent.

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all unit tests pass; `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add mcp/index.ts tests/mcp/server.test.ts package.json package-lock.json
git commit -m "feat: scoped Elves MCP server (read_canvas, add_comment, merge_sources, move_cards)"
```

---

### Task 4: Claude skill + MCP registration + end-to-end verification

**Files:**
- Create: `skill/elves-canvas.md`, `.mcp.json`, `e2e/claude-tools.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the tool handlers (`mcp/tools`) and the running Elves server + app (Phase 2a).
- Produces: the Claude skill; a Claude Code MCP registration; a Playwright test proving an MCP tool call lands in the open app.

- [ ] **Step 1: Write the failing end-to-end test**

`e2e/claude-tools.spec.ts` — drives the Task 2 tool handler against the running e2e server and asserts the app renders the result (the same server/app the Phase 2a e2e uses):
```ts
import { test, expect } from '@playwright/test'
import { addCommentTool } from '../mcp/tools'

const BASE = 'http://localhost:5199'

async function firstCardId(request: any): Promise<string> {
  const res = await request.get(`${BASE}/cards`)
  const cards = await res.json()
  return cards[0].id
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('an MCP add_comment tool call lands as a comment in the open app', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await page.waitForTimeout(800)

  const cardId = await firstCardId(request)
  await addCommentTool(BASE, { cardId, text: 'MCP says: no source', type: 'needs-evidence' })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('MCP says: no source')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/claude-tools.spec.ts`
Expected: FAIL — `GET /cards` returns the digest (fine), but the assertion fails only if the chain is broken; if Tasks 1–2 are in place this may already pass. If it passes immediately, that is acceptable (the chain is real) — proceed; the test still guards the Claude→app path. If it fails, fix the wiring before continuing.

- [ ] **Step 3: Write the Claude skill**

`skill/elves-canvas.md`:
```markdown
---
name: elves-canvas
description: Use when helping the user shape a piece on their Elves canvas — reviewing prose for weaknesses, deduplicating source notes, or reordering points. Requires the Elves MCP server (comment/merge/move tools) and the Elves app open.
---

# Working on the Elves canvas

You are a second pair of eyes on the user's writing canvas. You help them find the
shape of a piece. **You never write or edit their prose** — you comment, dedupe, and
reorder. There is no tool to write card text; that is deliberate.

## The canvas
- Two kinds of card: **prose** (the user's own words — a point/sentence/paragraph) and
  **source** (raw reference material). Read them with `read_canvas`.
- **x = narrative order: left is earlier, right is later.** A card's horizontal
  position is its place in the piece.

## What you can do
- **`read_canvas`** — always call this first to see the cards and their ids/positions.
- **`add_comment(cardId, text, type?)`** — flag a weakness in a PROSE card. Use a type:
  - `needs-evidence` — a claim with nothing backing it.
  - `weak-argument` — reasoning that doesn't hold up or has an obvious counter.
  - `needs-citation` — a specific fact/quote that needs a source.
  - omit `type` for a freeform note. Keep comments short and specific.
- **`merge_sources(cardIds)`** — collapse duplicate SOURCE cards. The first id is kept;
  the rest hide under it (recoverable). Only merge cards that truly say the same thing.
- **`move_cards(moves)`** — reorder. To bring a point earlier, give it a smaller x than
  the points it should come before. Move related points together.

## How to work
1. `read_canvas` first — never guess ids.
2. Do what the user asked, narrowly. Propose nothing you can't do with these four tools.
3. The user is watching; changes appear live and they can undo any of them.
4. Never put your own wording into a prose card. If you think a sentence is weak, say so
   in a comment — the user writes the fix.
```

- [ ] **Step 4: Register the MCP server for Claude Code**

`.mcp.json`:
```json
{
  "mcpServers": {
    "elves": {
      "command": "npx",
      "args": ["tsx", "mcp/index.ts"],
      "env": { "ELVES_URL": "http://localhost:5199" }
    }
  }
}
```

- [ ] **Step 5: Document it in the README**

Add a "Phase 2b — Claude" section to `README.md` after the Phase 2a section:
```markdown
## Using Claude (Phase 2b)

With the app running (`npm run dev:all`), Claude reaches the canvas through a scoped
MCP server. In Claude Code, opening this project offers the `elves` MCP server
(see `.mcp.json`); approve it. Then ask Claude things like "read my canvas and flag
weak spots", "dedupe my source cards", or "reorder these points for flow". Claude's
changes appear live and are undoable.

Claude has exactly four tools — `read_canvas`, `add_comment`, `merge_sources`,
`move_cards`. There is deliberately no tool to write card text: Claude comments,
dedupes, and reorders, but never writes your prose. See `skill/elves-canvas.md`.
```

- [ ] **Step 6: Run the end-to-end test to verify it passes**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/claude-tools.spec.ts`
Expected: PASS — the MCP `add_comment` tool call renders a comment in the app.

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npm run typecheck && rm -f .e2e/canvas.json && npm run e2e`
Expected: all unit tests, `tsc --noEmit`, and all Playwright specs green.

- [ ] **Step 8: Commit**

```bash
git add skill/elves-canvas.md .mcp.json e2e/claude-tools.spec.ts README.md
git commit -m "feat: Claude skill + MCP registration + Claude-tool e2e"
```

---

## Phase 2b Definition of Done
- A scoped MCP server exposes exactly `read_canvas`, `add_comment`, `merge_sources`, `move_cards` — no card-text-writing tool.
- `read_canvas` returns a clean card digest via `GET /cards`; the three mutation tools post `author:'claude'` change-sets through `/changeset`, and the open app applies + persists them.
- The server rejects (defense-in-depth) any change-set that would write card text.
- A Playwright test proves an MCP tool call lands live in the app.
- A Claude skill + `.mcp.json` let the user drive it from Claude Code.
- `npm test`, `npm run typecheck`, and `npm run e2e` are all green.

## Deferred beyond Phase 2 (future)
- Tags, suggest-links, `create_source_card` (splitting/deriving) — with Phase 3 (images) or later.
- Contradiction-over-time (needs Tana provenance); assisted Tana import; MDX export; live-store reads; multi-device.

## Self-Review (done during authoring)
- **Spec coverage:** scoped MCP server = capability boundary, four tools (spec §5, §9) → Tasks 2, 3; `read_canvas` digest (§9) → Tasks 1, 2; mutations via `/changeset` to the open app (§9) → Tasks 2, 4; server-side text guard / defense-in-depth (§3, §9 + final-review item) → Task 1; x-axis narrative order in tool + skill (§4) → Tasks 3, 4; Claude skill (§12 Phase 2b) → Task 4; turn-based, app-open, author:'claude' → Tasks 2, 4. Deferred items (tags/links/create_source_card/images/Tana/MDX) correctly absent.
- **Placeholder scan:** none; every code/test step is complete.
- **Type consistency:** `CardDigest` identical in `server/digest.ts` (Task 1) and consumed in `mcp/elvesClient.ts`/`mcp/tools.ts` (Task 2); `ChangeSet`/`Op`/`changeSetWritesText` consistent across Tasks 1–2; the four tool names identical across the MCP server (Task 3), the skill (Task 4), and the tool-list test; `makeChangeSet`/`*Tool` signatures consistent across Tasks 2–4.
