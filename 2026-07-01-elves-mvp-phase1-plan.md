# Elves MVP — Phase 1 (Canvas Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app where you can create, type into, move, group, and persist **source cards** and **prose cards** on a tldraw canvas rendered in a chosen typeface, with the two card types visually distinct and the whole canvas saved to a local `canvas.json` owned by a small Node server.

**Architecture:** A React + tldraw single-page app renders cards as a **custom tldraw shape**. The tldraw store snapshot is the canvas document. A tiny Express server **owns `canvas.json` on disk** (single source of truth) and exposes `GET`/`POST /canvas`; the app loads on mount and saves (debounced) on change. Pure, framework-free modules hold the card data model and persistence logic so the important rules are unit-tested without a running browser. This deliberately establishes the file-on-disk + server ownership from day one, so Phase 2 can add Claude as a second, restricted writer without re-architecting persistence.

**Tech Stack:** TypeScript, Vite, React 18, tldraw v3, Express, Vitest (unit), Playwright (e2e), tsx.

## Global Constraints

Copied from the spec; every task inherits these.

- **Claude never writes prose — structural, not behavioural.** Phase 1 builds *no* Claude write path of any kind. The only way card text changes is a human editing it in the app. The invariant is encoded as a tested pure function (`claudeMayEditCardText` → always `false`) that Phase 2's tool layer will consume.
- **Local-first, single device.** Data is a plain JSON file on disk. No cloud, no sync, no auth.
- **Cards render in a chosen typeface, never tldraw's hand-drawn default.** One CSS variable, `--elves-card-font`, is the single swap point. Phase 1 default: `'Inter', system-ui, sans-serif`.
- **Two card types, visually distinct.** `source` cards are muted and carry a small origin badge (`tana` | `image` | `typed`); `prose` cards are foregrounded in the chosen typeface.
- **One canvas file per piece.** The canvas path is a single configurable value (`ELVES_CANVAS` env, default `data/canvas.json`).
- **Terminology is load-bearing:** the two card kinds are exactly `source` and `prose`.

## Project Layout (created across the tasks below)

```
Elves/
  package.json            # scripts + deps (Task 1)
  tsconfig.json           # (Task 1)
  vite.config.ts          # (Task 1)
  vitest.config.ts        # (Task 1)
  playwright.config.ts    # (Task 6)
  index.html              # (Task 1)
  .gitignore              # (Task 1)
  src/
    main.tsx              # React entry (Task 1, filled in Task 6)
    App.tsx               # tldraw canvas + persistence wiring (Task 6)
    meta.ts               # tiny constant for the scaffold sanity test (Task 1)
    theme.css             # --elves-card-font + app layout (Task 6)
    model/
      types.ts           # Card kinds, CardProps (Task 2)
      cards.ts           # pure factories + guards + Claude invariant (Task 2)
    client/
      persistence.ts     # loadCanvas / saveCanvas / debounce (Task 5)
    shapes/
      CardShapeUtil.tsx  # custom tldraw shape (Task 6, editing in Task 7)
      card.css           # card visual language (Task 6)
  server/
    store.ts             # read/write canvas.json atomically (Task 3)
    app.ts               # createServer(dataPath) → Express app (Task 4)
    index.ts             # listen() entrypoint (Task 4)
  tests/
    meta.test.ts         # scaffold sanity (Task 1)
    model/cards.test.ts  # (Task 2)
    server/store.test.ts # (Task 3)
    server/api.test.ts   # (Task 4)
    client/persistence.test.ts # (Task 5)
  e2e/
    smoke.spec.ts        # app boots (Task 6)
    cards.spec.ts        # create/edit/persist loop (Task 7)
  data/                  # canvas.json lives here (gitignored)
```

> **tldraw API note:** This plan is written against **tldraw v3**. If `npm install` pulls a different major, verify the shape API (`ShapeUtil`, `RecordProps`, `T.literalEnum`, `getSnapshot`/`loadSnapshot`, `store.listen`) via context7 (`resolve-library-id` → `tldraw`, then `query-docs`) or tldraw.dev before Task 6. The run-test-verify steps will surface any drift.

---

### Task 1: Project scaffold & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`, `src/main.tsx`, `src/App.tsx`, `src/meta.ts`
- Test: `tests/meta.test.ts`

**Interfaces:**
- Produces: `src/meta.ts` exports `export const ELVES = 'elves'` (used only to prove the toolchain runs).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "elves",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "server": "tsx watch server/index.ts",
    "start": "tsx server/index.ts",
    "dev:all": "concurrently -k \"npm:server\" \"npm:dev\"",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tldraw": "^3.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@types/supertest": "^6.0.2",
    "@vitejs/plugin-react": "^4.3.1",
    "concurrently": "^9.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create the config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "server", "tests"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

`.gitignore`:
```
node_modules
dist
data
.e2e
playwright-report
test-results
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Elves</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the placeholder app + meta constant**

`src/meta.ts`:
```ts
export const ELVES = 'elves'
```

`src/App.tsx`:
```tsx
export default function App() {
  return <div id="app-root">Elves</div>
}
```

`src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 4: Write the scaffold sanity test**

`tests/meta.test.ts`:
```ts
import { expect, test } from 'vitest'
import { ELVES } from '../src/meta'

test('toolchain runs and resolves src imports', () => {
  expect(ELVES).toBe('elves')
})
```

- [ ] **Step 5: Install and run the test**

Run:
```bash
npm install
npm test
```
Expected: Vitest reports `tests/meta.test.ts` **1 passed**.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Elves (vite + react + ts + vitest)"
```

---

### Task 2: Card data model (pure)

**Files:**
- Create: `src/model/types.ts`, `src/model/cards.ts`
- Test: `tests/model/cards.test.ts`

**Interfaces:**
- Produces:
  - `type CardKind = 'source' | 'prose'`, `type SourceKind = 'text' | 'image'`, `type Origin = 'tana' | 'image' | 'typed'`
  - `interface CardProps { w: number; h: number; kind: CardKind; sourceKind: SourceKind | null; origin: Origin | null; text: string }`
  - `makeProseCardProps(text?: string): CardProps`
  - `makeSourceCardProps(text?: string, origin?: Origin): CardProps`
  - `isProseCard(p: { kind: CardKind }): boolean`, `isSourceCard(p: { kind: CardKind }): boolean`
  - `claudeMayEditCardText(kind: CardKind): boolean` — the encoded core invariant, consumed by Phase 2.
  - Constants `CARD_DEFAULT_W = 240`, `CARD_DEFAULT_H = 120`.

- [ ] **Step 1: Write the failing test**

`tests/model/cards.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import {
  makeProseCardProps, makeSourceCardProps, isProseCard, isSourceCard,
  claudeMayEditCardText, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from '../../src/model/cards'

describe('card factories', () => {
  test('prose card defaults to your voice, no source metadata', () => {
    const p = makeProseCardProps('a point I wrote')
    expect(p).toEqual({
      w: CARD_DEFAULT_W, h: CARD_DEFAULT_H, kind: 'prose',
      sourceKind: null, origin: null, text: 'a point I wrote',
    })
    expect(isProseCard(p)).toBe(true)
    expect(isSourceCard(p)).toBe(false)
  })

  test('source card is typed reference material by default', () => {
    const s = makeSourceCardProps('raw note')
    expect(s.kind).toBe('source')
    expect(s.sourceKind).toBe('text')
    expect(s.origin).toBe('typed')
    expect(isSourceCard(s)).toBe(true)
  })

  test('source card origin can be set', () => {
    expect(makeSourceCardProps('x', 'tana').origin).toBe('tana')
  })
})

describe('core invariant: Claude never authors card text', () => {
  test('Claude may not edit the text of any existing card', () => {
    expect(claudeMayEditCardText('prose')).toBe(false)
    expect(claudeMayEditCardText('source')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/model/cards.test.ts`
Expected: FAIL — cannot find module `../../src/model/cards`.

- [ ] **Step 3: Write the implementation**

`src/model/types.ts`:
```ts
export type CardKind = 'source' | 'prose'
export type SourceKind = 'text' | 'image'
export type Origin = 'tana' | 'image' | 'typed'

export interface CardProps {
  w: number
  h: number
  kind: CardKind
  /** Set when kind === 'source'; null for prose. */
  sourceKind: SourceKind | null
  /** Provenance for source cards; null for prose. */
  origin: Origin | null
  /** Human-authored. For source cards this is reference text, never prose. */
  text: string
}

export const CARD_DEFAULT_W = 240
export const CARD_DEFAULT_H = 120
```

`src/model/cards.ts`:
```ts
import {
  CardKind, CardProps, Origin, CARD_DEFAULT_W, CARD_DEFAULT_H,
} from './types'

export { CARD_DEFAULT_W, CARD_DEFAULT_H }

export function makeProseCardProps(text = ''): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'prose', sourceKind: null, origin: null, text,
  }
}

export function makeSourceCardProps(text = '', origin: Origin = 'typed'): CardProps {
  return {
    w: CARD_DEFAULT_W, h: CARD_DEFAULT_H,
    kind: 'source', sourceKind: 'text', origin, text,
  }
}

export function isProseCard(p: { kind: CardKind }): boolean {
  return p.kind === 'prose'
}

export function isSourceCard(p: { kind: CardKind }): boolean {
  return p.kind === 'source'
}

/**
 * Elves' core rule, as testable code. Claude never edits the text of an
 * existing card — source or prose. (Claude *creating* new source cards is a
 * separate, dedicated capability added in Phase 2's tool layer; it is not
 * text-editing.) Phase 2's server tool API MUST consult this before applying
 * any text mutation attributed to Claude.
 */
export function claudeMayEditCardText(_kind: CardKind): boolean {
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/model/cards.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/model tests/model
git commit -m "feat: card data model (source/prose) with Claude-never-writes invariant"
```

---

### Task 3: Canvas persistence store (server owns the file)

**Files:**
- Create: `server/store.ts`
- Test: `tests/server/store.test.ts`

**Interfaces:**
- Produces:
  - `type CanvasSnapshot = Record<string, unknown>`
  - `const EMPTY_CANVAS: CanvasSnapshot` (shape `{ document: null, session: null }`, matching tldraw's snapshot shape)
  - `readCanvas(path: string): Promise<CanvasSnapshot>` — returns a fresh `EMPTY_CANVAS` if the file is missing.
  - `writeCanvas(path: string, data: CanvasSnapshot): Promise<void>` — atomic (temp file + rename), creates parent dir.

- [ ] **Step 1: Write the failing test**

`tests/server/store.test.ts`:
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EMPTY_CANVAS, readCanvas, writeCanvas } from '../../server/store'

let dirs: string[] = []
async function tmpDir() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('reading a missing canvas returns a fresh empty canvas', async () => {
  const d = await tmpDir()
  expect(await readCanvas(join(d, 'canvas.json'))).toEqual(EMPTY_CANVAS)
})

test('write then read round-trips the snapshot', async () => {
  const d = await tmpDir()
  const path = join(d, 'nested', 'canvas.json')
  const snap = { document: { schema: 1, records: [] }, session: null }
  await writeCanvas(path, snap)
  expect(await readCanvas(path)).toEqual(snap)
})

test('write is atomic: no leftover temp file', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, { document: null, session: null })
  const entries = await fs.readdir(d)
  expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/store.test.ts`
Expected: FAIL — cannot find module `../../server/store`.

- [ ] **Step 3: Write the implementation**

`server/store.ts`:
```ts
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export type CanvasSnapshot = Record<string, unknown>

export const EMPTY_CANVAS: CanvasSnapshot = { document: null, session: null }

export async function readCanvas(path: string): Promise<CanvasSnapshot> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as CanvasSnapshot
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_CANVAS }
    }
    throw err
  }
}

export async function writeCanvas(path: string, data: CanvasSnapshot): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, path)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/store.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add server/store.ts tests/server/store.test.ts
git commit -m "feat: atomic canvas.json read/write store"
```

---

### Task 4: Server HTTP API

**Files:**
- Create: `server/app.ts`, `server/index.ts`
- Test: `tests/server/api.test.ts`

**Interfaces:**
- Consumes: `readCanvas`, `writeCanvas`, `CanvasSnapshot` from `server/store`.
- Produces:
  - `createServer(dataPath: string): express.Express` — an app with:
    - `GET /canvas` → `200` JSON snapshot (empty canvas if none saved).
    - `POST /canvas` → `200 { ok: true }` after persisting a JSON-object body; `400 { error }` if the body is not a JSON object.
    - CORS enabled (dev app runs on a different port).

- [ ] **Step 1: Write the failing test**

`tests/server/api.test.ts`:
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'

let dirs: string[] = []
async function appWithTmp() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-'))
  dirs.push(d)
  return createServer(join(d, 'canvas.json'))
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('GET /canvas returns an empty canvas before anything is saved', async () => {
  const app = await appWithTmp()
  const res = await request(app).get('/canvas')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ document: null, session: null })
})

test('POST then GET round-trips the snapshot', async () => {
  const app = await appWithTmp()
  const snap = { document: { schema: 1, records: [] }, session: null }
  const post = await request(app).post('/canvas').send(snap)
  expect(post.status).toBe(200)
  expect(post.body).toEqual({ ok: true })
  const get = await request(app).get('/canvas')
  expect(get.body).toEqual(snap)
})

test('POST rejects a non-object body', async () => {
  const app = await appWithTmp()
  const res = await request(app).post('/canvas').send([1, 2, 3])
  expect(res.status).toBe(400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/api.test.ts`
Expected: FAIL — cannot find module `../../server/app`.

- [ ] **Step 3: Write the implementation**

`server/app.ts`:
```ts
import express from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'

export function createServer(dataPath: string) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '64mb' }))

  app.get('/canvas', async (_req, res) => {
    res.json(await readCanvas(dataPath))
  })

  app.post('/canvas', async (req, res) => {
    const body = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'canvas must be a JSON object' })
      return
    }
    await writeCanvas(dataPath, body as CanvasSnapshot)
    res.json({ ok: true })
  })

  return app
}
```

`server/index.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'

const here = dirname(fileURLToPath(import.meta.url))
const dataPath = process.env.ELVES_CANVAS ?? join(here, '..', 'data', 'canvas.json')
const port = Number(process.env.PORT ?? 5199)

createServer(dataPath).listen(port, () => {
  console.log(`Elves server on http://localhost:${port}  (canvas: ${dataPath})`)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/api.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Verify the server actually boots**

Run: `npm run start`
Expected: logs `Elves server on http://localhost:5199 ...`. Stop it with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add server/app.ts server/index.ts tests/server/api.test.ts
git commit -m "feat: express server owning canvas.json (GET/POST /canvas)"
```

---

### Task 5: Client persistence module

**Files:**
- Create: `src/client/persistence.ts`
- Test: `tests/client/persistence.test.ts`

**Interfaces:**
- Produces:
  - `loadCanvas(): Promise<any>` — `GET`s the snapshot from the server base URL.
  - `saveCanvas(snapshot: unknown): Promise<void>` — `POST`s the snapshot.
  - `debounce<A extends any[]>(fn: (...a: A) => void, ms: number): (...a: A) => void`
  - Base URL from `import.meta.env.VITE_SERVER_URL`, defaulting to `http://localhost:5199`.

- [ ] **Step 1: Write the failing test**

`tests/client/persistence.test.ts`:
```ts
import { afterEach, expect, test, vi } from 'vitest'
import { debounce, loadCanvas, saveCanvas } from '../../src/client/persistence'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('loadCanvas GETs and returns the parsed snapshot', async () => {
  const snap = { document: null, session: null }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snap })))
  expect(await loadCanvas()).toEqual(snap)
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/canvas'))
})

test('saveCanvas POSTs the snapshot as JSON', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', fetchMock)
  await saveCanvas({ a: 1 })
  const [, init] = fetchMock.mock.calls[0]
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body)).toEqual({ a: 1 })
})

test('debounce collapses rapid calls into one trailing call', () => {
  vi.useFakeTimers()
  const spy = vi.fn()
  const d = debounce(spy, 500)
  d('a'); d('b'); d('c')
  expect(spy).not.toHaveBeenCalled()
  vi.advanceTimersByTime(500)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('c')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/client/persistence.test.ts`
Expected: FAIL — cannot find module `../../src/client/persistence`.

- [ ] **Step 3: Write the implementation**

`src/client/persistence.ts`:
```ts
const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export async function loadCanvas(): Promise<any> {
  const res = await fetch(`${BASE}/canvas`)
  if (!res.ok) throw new Error(`load failed: ${res.status}`)
  return res.json()
}

export async function saveCanvas(snapshot: unknown): Promise<void> {
  const res = await fetch(`${BASE}/canvas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
}

export function debounce<A extends any[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/client/persistence.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/client tests/client
git commit -m "feat: client canvas persistence (load/save + debounce)"
```

---

### Task 6: Card shape + app shell + persistence wiring

**Files:**
- Create: `src/shapes/CardShapeUtil.tsx`, `src/shapes/card.css`, `src/theme.css`, `playwright.config.ts`, `e2e/smoke.spec.ts`
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: `makeProseCardProps`, `makeSourceCardProps` (`src/model/cards`); `loadCanvas`, `saveCanvas`, `debounce` (`src/client/persistence`); `CardKind`, `SourceKind`, `Origin` (`src/model/types`).
- Produces:
  - `type CardShape = TLBaseShape<'card', CardProps>` where `CardProps` mirrors `src/model/types`.
  - `class CardShapeUtil extends ShapeUtil<CardShape>` with `static type = 'card'`.
  - `App` renders `<Tldraw shapeUtils={[CardShapeUtil]} onMount={...} />`, loading the snapshot on mount and saving (debounced 500ms) on document change.

- [ ] **Step 1: Install Playwright browser + write the smoke test**

Run: `npx playwright install chromium`

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'ELVES_CANVAS=.e2e/canvas.json PORT=5199 npm run start',
      port: 5199,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: false,
    },
  ],
})
```

`e2e/smoke.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('app boots and mounts the tldraw canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
})
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `npm run e2e -- e2e/smoke.spec.ts`
Expected: FAIL — no `.tl-canvas` (App still renders the placeholder text).

- [ ] **Step 3: Write the card visual language**

`src/theme.css`:
```css
:root {
  --elves-card-font: 'Inter', system-ui, -apple-system, sans-serif;
}
html, body, #root { height: 100%; margin: 0; }
#app-root { position: fixed; inset: 0; }
```

`src/shapes/card.css`:
```css
.elves-card {
  box-sizing: border-box;
  padding: 12px 14px;
  border-radius: 10px;
  font-family: var(--elves-card-font);
  font-size: 15px;
  line-height: 1.4;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #ffffff;
  border: 1px solid #e6e6e6;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.elves-card--prose { color: #14110f; border-color: #d8d4cf; }
.elves-card--source {
  color: #6b6560;
  background: #f6f4f1;
  border-style: dashed;
  border-color: #cbc4bc;
}
.elves-badge {
  align-self: flex-start;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: #e7e1d8;
  color: #6b6560;
}
.elves-card__text { white-space: pre-wrap; flex: 1; }
.elves-card__editor {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font: inherit;
  color: inherit;
}
```

- [ ] **Step 4: Write the card shape**

`src/shapes/CardShapeUtil.tsx`:
```tsx
import {
  ShapeUtil, TLBaseShape, HTMLContainer, Rectangle2d, Geometry2d, T, RecordProps,
} from 'tldraw'
import type { CardKind, SourceKind, Origin } from '../model/types'
import { makeProseCardProps } from '../model/cards'
import './card.css'

export type CardShape = TLBaseShape<'card', {
  w: number
  h: number
  kind: CardKind
  sourceKind: SourceKind | null
  origin: Origin | null
  text: string
}>

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const
  static override props: RecordProps<CardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('source', 'prose'),
    sourceKind: T.nullable(T.literalEnum('text', 'image')),
    origin: T.nullable(T.literalEnum('tana', 'image', 'typed')),
    text: T.string,
  }

  getDefaultProps(): CardShape['props'] {
    // Delegate to the unit-tested model factory so defaults stay DRY.
    return makeProseCardProps()
  }

  getGeometry(shape: CardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: CardShape) {
    const { kind, origin, text } = shape.props
    return (
      <HTMLContainer>
        <div className={`elves-card elves-card--${kind}`} style={{ width: '100%', height: '100%' }}>
          {kind === 'source' && (
            <span className="elves-badge" data-testid="card-badge">{origin ?? 'source'}</span>
          )}
          <div className="elves-card__text" data-testid="card-text">{text}</div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={10} />
  }

  override canResize() { return true }
  override canEdit() { return true }
}
```

- [ ] **Step 5: Wire the app shell + persistence**

`src/App.tsx`:
```tsx
import { Tldraw, Editor, getSnapshot, loadSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil } from './shapes/CardShapeUtil'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'

const shapeUtils = [CardShapeUtil]

export default function App() {
  const handleMount = async (editor: Editor) => {
    const snapshot = await loadCanvas()
    if (snapshot && snapshot.document) {
      loadSnapshot(editor.store, snapshot)
    }
    const save = debounce(() => saveCanvas(getSnapshot(editor.store)), 500)
    editor.store.listen(save, { source: 'user', scope: 'document' })
  }

  return (
    <div id="app-root">
      <Tldraw shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
```

`src/main.tsx` stays as written in Task 1 (renders `<App />`).

- [ ] **Step 6: Run the smoke test to verify it passes**

Run: `npm run e2e -- e2e/smoke.spec.ts`
Expected: PASS — the tldraw canvas is visible.

- [ ] **Step 7: Commit**

```bash
git add src playwright.config.ts e2e/smoke.spec.ts
git commit -m "feat: card shape + tldraw app shell wired to canvas.json"
```

---

### Task 7: Create & edit source and prose cards (full loop)

**Files:**
- Modify: `src/App.tsx` (add a small toolbar), `src/shapes/CardShapeUtil.tsx` (inline text editing)
- Create: `e2e/cards.spec.ts`

**Interfaces:**
- Consumes: `makeProseCardProps`, `makeSourceCardProps` (`src/model/cards`); `CardShape`, `CardShapeUtil` (`src/shapes/CardShapeUtil`).
- Produces:
  - A toolbar with two buttons: `data-testid="new-prose"` and `data-testid="new-source"`, each creating the corresponding card at the viewport centre and selecting it.
  - Inline editing: double-clicking a card shows a `<textarea class="elves-card__editor">` bound to `shape.props.text`; edits persist via the store listener from Task 6.

- [ ] **Step 1: Write the failing e2e test**

`e2e/cards.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('create a prose card, type into it, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  const card = page.locator('.elves-card--prose').first()
  await expect(card).toBeVisible()

  await card.dblclick()
  await page.locator('.elves-card__editor').fill('composition was the bottleneck')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(card.getByTestId('card-text')).toHaveText('composition was the bottleneck')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  await expect(
    page.locator('.elves-card--prose').getByText('composition was the bottleneck'),
  ).toBeVisible({ timeout: 15000 })
})

test('source card is muted and shows its origin badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-source').click()
  const source = page.locator('.elves-card--source').first()
  await expect(source).toBeVisible()
  await expect(source.getByTestId('card-badge')).toHaveText('typed')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run e2e -- e2e/cards.spec.ts`
Expected: FAIL — no `new-prose` / `new-source` buttons exist.

> Clean the e2e canvas between runs so a stale card doesn't mask a regression:
> `rm -f .e2e/canvas.json`

- [ ] **Step 3: Add inline editing to the card shape**

In `src/shapes/CardShapeUtil.tsx`, replace the `component` method with the editing-aware version:

```tsx
  component(shape: CardShape) {
    const { kind, origin, text } = shape.props
    const isEditing = this.editor.getEditingShapeId() === shape.id
    return (
      <HTMLContainer>
        <div className={`elves-card elves-card--${kind}`} style={{ width: '100%', height: '100%' }}>
          {kind === 'source' && (
            <span className="elves-badge" data-testid="card-badge">{origin ?? 'source'}</span>
          )}
          {isEditing ? (
            <textarea
              className="elves-card__editor"
              autoFocus
              defaultValue={text}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                this.editor.updateShape<CardShape>({
                  id: shape.id,
                  type: 'card',
                  props: { text: e.currentTarget.value },
                })
              }
            />
          ) : (
            <div className="elves-card__text" data-testid="card-text">{text}</div>
          )}
        </div>
      </HTMLContainer>
    )
  }
```

- [ ] **Step 4: Add the create-card toolbar to the app**

In `src/App.tsx`, import the factories and render a toolbar over the canvas. Replace the file with:

```tsx
import { useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { makeProseCardProps, makeSourceCardProps } from './model/cards'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'

const shapeUtils = [CardShapeUtil]

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null)

  const handleMount = async (ed: Editor) => {
    setEditor(ed)
    const snapshot = await loadCanvas()
    if (snapshot && snapshot.document) loadSnapshot(ed.store, snapshot)
    const save = debounce(() => saveCanvas(getSnapshot(ed.store)), 500)
    ed.store.listen(save, { source: 'user', scope: 'document' })
  }

  const addCard = (kind: 'prose' | 'source') => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props = kind === 'prose' ? makeProseCardProps() : makeSourceCardProps()
    const id = createShapeId()
    editor.createShape<CardShape>({
      id, type: 'card',
      x: center.x - props.w / 2, y: center.y - props.h / 2,
      props,
    })
    editor.select(id)
  }

  return (
    <div id="app-root">
      <div className="elves-toolbar">
        <button data-testid="new-prose" onClick={() => addCard('prose')}>+ Prose</button>
        <button data-testid="new-source" onClick={() => addCard('source')}>+ Source</button>
      </div>
      <Tldraw shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
```

Add `createShapeId` to the tldraw import line:
```tsx
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
```

Append toolbar styles to `src/theme.css`:
```css
.elves-toolbar {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 300;
  display: flex;
  gap: 8px;
}
.elves-toolbar button {
  font-family: var(--elves-card-font);
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #d8d4cf;
  background: #fff;
  cursor: pointer;
}
```

- [ ] **Step 5: Run the e2e tests to verify they pass**

Run:
```bash
rm -f .e2e/canvas.json
npm run e2e -- e2e/cards.spec.ts
```
Expected: PASS — both tests green (prose card round-trips through reload; source card is muted with a `typed` badge).

- [ ] **Step 6: Run the full test suite**

Run: `npm test && npm run e2e`
Expected: all Vitest unit tests pass; all Playwright tests pass.

- [ ] **Step 7: Commit**

```bash
git add src e2e/cards.spec.ts
git commit -m "feat: create + inline-edit source/prose cards with persistence"
```

---

## Phase 1 Definition of Done

- `npm run dev:all` opens a canvas where **+ Prose** and **+ Source** add cards; prose cards show in `--elves-card-font`, source cards are muted with an origin badge.
- Double-click edits a card's text inline; changes persist to `data/canvas.json` and survive reload.
- `data/canvas.json` is a human-readable file you can open and inspect.
- `npm test` (unit) and `npm run e2e` (Playwright) are green.
- The core invariant `claudeMayEditCardText` exists and is tested, ready for Phase 2 to consume.

## Deferred to later phases (not this plan)
- **Phase 2:** scoped Claude tool API on the server (no prose-write), flags/comments/tags/clusters/dedupe-suggestions with accept/dismiss, the Claude skill, websocket hot-reload on Claude edits.
- **Phase 3:** drag-in image source cards; Claude vision deriving source cards from an image.
- **Beyond MVP:** Tana bulk import (assisted), MDX export, live co-presence, multi-device sync, multi-piece studio. (Spec §11.)

## Self-Review (done during authoring)
- **Spec coverage (Phase-1 slice):** source/prose cards (§5) → Tasks 2, 6, 7; visual distinction + typeface + origin badge (§3, §5) → Tasks 6, 7; file-backed local-first persistence + server ownership (§9) → Tasks 3, 4, 5, 6; "Claude never writes prose" as structure (§3, §6) → Task 2 invariant + the deliberate absence of any Claude write path in Phase 1; one canvas file per piece (§3) → `ELVES_CANVAS` in Task 4. Import from Tana and MDX export are correctly **absent** (deferred per spec §2/§11).
- **Placeholder scan:** no TBD/TODO; every code and test step is complete and runnable.
- **Type consistency:** `CardProps` fields (`w,h,kind,sourceKind,origin,text`) are identical in `src/model/types.ts` (Task 2) and `CardShape` (Task 6); `makeProseCardProps`/`makeSourceCardProps` signatures match their uses in Tasks 6–7; `createServer(dataPath)` matches its test and `index.ts` use.
