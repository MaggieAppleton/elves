# Elves Phase 3a (Image Source Cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person drag or add an image (photo of paper notes, Procreate/iPad sketch) onto the canvas as an **image source card** that renders the image, is stored local-first as a file on disk, and moves/resizes/persists like any card — with no Claude involved.

**Architecture:** The Elves server gains an asset store: `POST /assets` writes the image bytes to `data/assets/<id>.<ext>` (a sibling of the canvas file) and returns an `assetId`; `GET /assets/:id` serves it (path-traversal-safe). The card shape gains an `assetId` prop (via a shape-props migration). In the app, a "+ Image" button (and drag-drop) uploads the file and creates an image source card sized to the image's aspect ratio; the card component renders `<img>` for `sourceKind: 'image'` cards.

**Tech Stack:** TypeScript, React 18, tldraw v3, Express (`express.raw`), Vitest, Playwright. No new dependencies.

## Global Constraints

Copied from the Phase 3 spec; every task inherits these.

- An **image source card** is a source card with `sourceKind: 'image'`, `origin: 'image'`, `assetId` set, and `text: ''` (empty). It is not a new shape type.
- **Storage is local-first files, not base64.** Image bytes live in `data/assets/` (the `assets` dir is a sibling of the canvas file, derived from `ELVES_CANVAS`). `POST /assets` takes a raw image body and returns `{ assetId }`; `GET /assets/:id` serves it and must reject path traversal. `canvas.json` only stores the `assetId`.
- **`assetId`** is a safe bare filename of the form `<uuid>.<ext>` (no slashes, no `..`).
- New card prop **`assetId: string | null`** (default `null`), added via a shape-props migration `AddAssetId` (version 2, after the existing `AddComments` version 1).
- **Rendering:** an image card renders `<img>` with `object-fit: contain` filling the card; it drags and resizes like any card.
- **No Claude in 3a.** No change-set op, no MCP change. (Transcription is Phase 3b.)

## Project Layout (added/changed by this plan)

```
server/
  assets.ts       # assetsDir, extForMime, saveAsset, resolveAssetPath        (Task 1)
  app.ts          # + POST /assets, GET /assets/:id                            (Task 1)
src/model/
  types.ts        # CardProps gains assetId                                    (Task 2)
  cards.ts        # factories default assetId; + makeImageSourceCardProps      (Task 2)
src/shapes/
  CardShapeUtil.tsx  # assetId prop + AddAssetId migration; <img> rendering    (Task 2, 3)
  card.css           # image card styles                                       (Task 3)
src/client/
  assets.ts       # uploadAsset(file), assetUrl(assetId)                       (Task 3)
src/App.tsx       # + Image button, hidden file input, drop handler, addImageCard (Task 3)
tests/
  server/assets.test.ts       (Task 1)
  server/changeset.test.ts    # + POST/GET /assets integration tests (append)  (Task 1)
  model/cards.test.ts         # updated for assetId (Task 2)
  shapes/migration.test.ts    # + AddAssetId (append)                          (Task 2)
e2e/
  fixtures/handwriting.png    # tiny test image                                (Task 3)
  images.spec.ts             (Task 3)
```

> **tldraw v3 API note:** Task 2 adds a second shape-props migration (`createShapePropsMigrationIds`/`createShapePropsMigrationSequence` are already used in `CardShapeUtil`). Task 3 uses `editor.registerExternalContentHandler('files', …)` for drag-drop — verify this exact API against installed tldraw 3.15.6 via context7 (`resolve-library-id` → `tldraw`, `query-docs`) before writing; if it differs, adapt to intercept image-file drops and call the same `addImageCard` function (the "+ Image" button path is the tested one, so a drag-drop API difference is non-blocking).

---

### Task 1: Server — asset storage + endpoints

**Files:**
- Create: `server/assets.ts`, `tests/server/assets.test.ts`
- Modify: `server/app.ts`, and append two tests to `tests/server/changeset.test.ts`

**Interfaces:**
- Consumes: nothing new (uses `dataPath` already threaded through `createServer`).
- Produces:
  - `assetsDir(canvasPath: string): string` — the `assets` dir sibling of the canvas file.
  - `extForMime(mime: string): string | null` — `image/png`→`png`, `image/jpeg`→`jpg`, `image/gif`→`gif`, `image/webp`→`webp`, `image/svg+xml`→`svg`, else `null`.
  - `saveAsset(dir: string, bytes: Buffer, ext: string): Promise<string>` — writes `<uuid>.<ext>`, returns the `assetId`.
  - `resolveAssetPath(dir: string, assetId: string): string | null` — absolute path, or `null` if `assetId` isn't a safe bare filename.
  - `POST /assets` (raw image body) → `200 { assetId }`, or `400` for a non-image/empty body.
  - `GET /assets/:id` → the file (with a content-type from its extension), `400` for a bad id, `404` if missing.

- [ ] **Step 1: Write the failing unit test**

`tests/server/assets.test.ts`:
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assetsDir, extForMime, saveAsset, resolveAssetPath } from '../../server/assets'

let dirs: string[] = []
async function tmp() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-assets-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('assetsDir is the assets sibling of the canvas file', () => {
  expect(assetsDir('/x/y/data/canvas.json')).toBe(join('/x/y/data', 'assets'))
})

test('extForMime maps image mimes and rejects others', () => {
  expect(extForMime('image/png')).toBe('png')
  expect(extForMime('image/jpeg')).toBe('jpg')
  expect(extForMime('text/plain')).toBeNull()
})

test('saveAsset writes <uuid>.<ext> and returns the id', async () => {
  const d = await tmp()
  const id = await saveAsset(d, Buffer.from([1, 2, 3]), 'png')
  expect(id).toMatch(/^[0-9a-f-]+\.png$/)
  expect(await fs.readFile(join(d, id))).toEqual(Buffer.from([1, 2, 3]))
})

test('resolveAssetPath rejects path traversal and accepts a bare filename', () => {
  const d = '/assets'
  expect(resolveAssetPath(d, 'a/b.png')).toBeNull()
  expect(resolveAssetPath(d, '../secret')).toBeNull()
  expect(resolveAssetPath(d, '.hidden')).toBeNull()
  expect(resolveAssetPath(d, 'abc.png')).toBe(join('/assets', 'abc.png'))
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/server/assets.test.ts`
Expected: FAIL — cannot find module `../../server/assets`.

- [ ] **Step 3: Implement `server/assets.ts`**

```ts
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export function assetsDir(canvasPath: string): string {
  return join(dirname(canvasPath), 'assets')
}

export function extForMime(mime: string): string | null {
  return EXT_BY_MIME[mime] ?? null
}

export async function saveAsset(dir: string, bytes: Buffer, ext: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const assetId = `${crypto.randomUUID()}.${ext}`
  await fs.writeFile(join(dir, assetId), bytes)
  return assetId
}

export function resolveAssetPath(dir: string, assetId: string): string | null {
  if (!assetId || assetId !== basename(assetId) || assetId.startsWith('.') || assetId.includes('..')) {
    return null
  }
  return resolve(dir, assetId)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/server/assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the endpoints to `server/app.ts`**

Add imports:
```ts
import { assetsDir, extForMime, saveAsset, resolveAssetPath } from './assets'
```
Add the two routes (near the `/canvas` routes; the app already has `app.use(express.json())` — the image routes use their own `express.raw` so JSON parsing is skipped for image bodies):
```ts
  app.post('/assets', express.raw({ type: ['image/*'], limit: '25mb' }), async (req, res) => {
    const ext = extForMime((req.headers['content-type'] ?? '').split(';')[0].trim())
    if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'expected a non-empty image body' })
      return
    }
    const assetId = await saveAsset(assetsDir(dataPath), req.body, ext)
    res.json({ assetId })
  })

  app.get('/assets/:id', (req, res) => {
    const path = resolveAssetPath(assetsDir(dataPath), req.params.id)
    if (!path) {
      res.status(400).json({ error: 'bad asset id' })
      return
    }
    res.sendFile(path, (err) => {
      if (err && !res.headersSent) res.status(404).end()
    })
  })
```

- [ ] **Step 6: Write the failing integration tests**

Append to `tests/server/changeset.test.ts` (it already imports `request`, `createServer`, and has a `tmpCanvas()` helper):
```ts
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('POST /assets stores an image and GET /assets/:id serves it', async () => {
  const app = createServer(await tmpCanvas())
  const post = await request(app).post('/assets').set('content-type', 'image/png').send(TINY_PNG)
  expect(post.status).toBe(200)
  expect(post.body.assetId).toMatch(/\.png$/)

  const get = await request(app).get(`/assets/${post.body.assetId}`)
  expect(get.status).toBe(200)
  expect(get.headers['content-type']).toContain('image/png')
})

test('POST /assets rejects a non-image body', async () => {
  const app = createServer(await tmpCanvas())
  const res = await request(app).post('/assets').set('content-type', 'text/plain').send('nope')
  expect(res.status).toBe(400)
})

test('GET /assets rejects a traversal id', async () => {
  const app = createServer(await tmpCanvas())
  const res = await request(app).get('/assets/..%2fpackage.json')
  expect([400, 404]).toContain(res.status)
})
```

- [ ] **Step 7: Run the server tests**

Run: `npm test -- tests/server/`
Expected: PASS — assets unit tests + the three new integration tests + existing server tests all green.

- [ ] **Step 8: Commit**

```bash
git add server/assets.ts server/app.ts tests/server/assets.test.ts tests/server/changeset.test.ts
git commit -m "feat: local-first asset store (POST /assets, GET /assets/:id)"
```

---

### Task 2: Model — `assetId` prop, image factory, migration

**Files:**
- Modify: `src/model/types.ts`, `src/model/cards.ts`, `tests/model/cards.test.ts`, `src/shapes/CardShapeUtil.tsx`, `tests/shapes/migration.test.ts`

**Interfaces:**
- Produces:
  - `CardProps` additionally has `assetId: string | null`.
  - `makeProseCardProps`/`makeSourceCardProps` default `assetId: null`.
  - `makeImageSourceCardProps(assetId: string): CardProps` → `{ w: 280, h: 200, kind: 'source', sourceKind: 'image', origin: 'image', text: '', comments: [], mergedInto: null, assetId }`.
  - `CardShape` props include `assetId`; `CardShapeUtil.props.assetId = T.nullable(T.string)`.
  - `export function addAssetIdUp(props: Record<string, unknown>): void` — sets `props.assetId = null`.
  - The migration sequence has `AddComments` (v1) **and** `AddAssetId` (v2).

- [ ] **Step 1: Extend the types + factories**

In `src/model/types.ts`, add to `CardProps` (after `mergedInto`):
```ts
  /** For image source cards: the stored asset id (a filename under data/assets/). null otherwise. */
  assetId: string | null
```

In `src/model/cards.ts`, add `assetId: null` to both existing factories, and add the image factory:
```ts
export function makeImageSourceCardProps(assetId: string): CardProps {
  return {
    w: 280, h: 200,
    kind: 'source', sourceKind: 'image', origin: 'image', text: '',
    comments: [], mergedInto: null, assetId,
  }
}
```
(Update `makeProseCardProps` and `makeSourceCardProps` to include `assetId: null`.)

- [ ] **Step 2: Update the failing model tests**

In `tests/model/cards.test.ts`, add `assetId: null` to the prose card's full `toEqual`, add `expect(s.assetId).toBeNull()` to the source test, and add a new test:
```ts
test('makeImageSourceCardProps builds an image source card', () => {
  const p = makeImageSourceCardProps('abc.png')
  expect(p).toEqual({
    w: 280, h: 200, kind: 'source', sourceKind: 'image', origin: 'image',
    text: '', comments: [], mergedInto: null, assetId: 'abc.png',
  })
})
```
Add the import for `makeImageSourceCardProps`.

- [ ] **Step 3: Run — model tests fail then pass**

Run: `npm test -- tests/model/cards.test.ts`
Expected: after Steps 1–2, PASS. (If you wrote the test before the factory, it FAILS on the missing export first.)

- [ ] **Step 4: Write the failing migration test**

Append to `tests/shapes/migration.test.ts`:
```ts
import { addAssetIdUp } from '../../src/shapes/CardShapeUtil'

test('AddAssetId migration adds assetId to a pre-image card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null,
  }
  addAssetIdUp(props)
  expect(props.assetId).toBeNull()
})
```

- [ ] **Step 5: Extend the shape — prop, migration, type**

In `src/shapes/CardShapeUtil.tsx`:

Add `assetId: string | null` to the `CardShape` props type. Add the validator to `static props`:
```ts
    assetId: T.nullable(T.string),
```
Add the migration step. Update the ids and sequence:
```ts
export function addAssetIdUp(props: Record<string, unknown>): void {
  props.assetId = null
}

const cardVersions = createShapePropsMigrationIds('card', { AddComments: 1, AddAssetId: 2 })

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
    {
      id: cardVersions.AddAssetId,
      up: (props) => addAssetIdUp(props as Record<string, unknown>),
      down: (props) => {
        delete (props as Record<string, unknown>).assetId
      },
    },
  ],
})
```

- [ ] **Step 6: Run the model + migration tests**

Run: `npm test -- tests/model/ tests/shapes/`
Expected: PASS — cards + both migration tests green.

- [ ] **Step 7: Regression-check the app still loads**

Run: `rm -f .e2e/canvas.json && npm run e2e`
Expected: PASS — existing Playwright specs still green with the new prop defaulted in.

- [ ] **Step 8: Commit**

```bash
git add src/model/types.ts src/model/cards.ts src/shapes/CardShapeUtil.tsx tests/model/cards.test.ts tests/shapes/migration.test.ts
git commit -m "feat: assetId card prop + image source factory + migration"
```

---

### Task 3: App — upload, create, render image cards

**Files:**
- Create: `src/client/assets.ts`, `e2e/fixtures/handwriting.png`, `e2e/images.spec.ts`
- Modify: `src/App.tsx`, `src/shapes/CardShapeUtil.tsx`, `src/shapes/card.css`

**Interfaces:**
- Consumes: `makeImageSourceCardProps` (`src/model/cards`); `CardShape` (`src/shapes/CardShapeUtil`).
- Produces:
  - `uploadAsset(file: File): Promise<string>` — POSTs the file to `/assets`, returns the `assetId`.
  - `assetUrl(assetId: string): string` — `{server}/assets/{assetId}`.
  - `addImageCard(editor, file, point?)` — uploads and creates an image source card sized to the image aspect ratio.
  - A `data-testid="new-image"` button + a hidden `data-testid="image-input"` file input; drag-drop of image files creates image cards too.
  - The card component renders `<img class="elves-card__image">` for `sourceKind: 'image'` cards with an `assetId`.

> Verify `editor.registerExternalContentHandler('files', …)` against installed tldraw before writing (see the API note). If unavailable, wire the button path only and note drag-drop as follow-up.

- [ ] **Step 1: Create the test fixture image**

Run (writes a tiny 1×1 PNG the e2e uploads):
```bash
mkdir -p e2e/fixtures && printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > e2e/fixtures/handwriting.png
```

- [ ] **Step 2: Write the failing e2e test**

`e2e/images.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('adding an image creates an image source card that renders and persists', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('image-input').setInputFiles('e2e/fixtures/handwriting.png')

  const img = page.locator('img.elves-card__image')
  await expect(img).toBeVisible({ timeout: 10000 })
  await expect(img).toHaveAttribute('src', /\/assets\/.+\.png$/)

  await page.waitForTimeout(800) // debounced save
  await page.reload()
  await expect(page.locator('img.elves-card__image')).toBeVisible({ timeout: 15000 })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/images.spec.ts`
Expected: FAIL — no image input / image rendering yet.

- [ ] **Step 4: Implement the asset client**

`src/client/assets.ts`:
```ts
const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export async function uploadAsset(file: File): Promise<string> {
  const res = await fetch(`${BASE}/assets`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  })
  if (!res.ok) throw new Error(`asset upload failed: ${res.status}`)
  const { assetId } = await res.json()
  return assetId as string
}

export function assetUrl(assetId: string): string {
  return `${BASE}/assets/${assetId}`
}
```

- [ ] **Step 5: Render images in the card**

In `src/shapes/CardShapeUtil.tsx`, import the helper and destructure the new props:
```ts
import { assetUrl } from '../client/assets'
```
In `component`, destructure `sourceKind` and `assetId` from `shape.props`, and render the image branch first (before the editing/text branch):
```tsx
            {sourceKind === 'image' && assetId ? (
              <img
                className="elves-card__image"
                src={assetUrl(assetId)}
                alt=""
                draggable={false}
                data-testid="card-image"
              />
            ) : isEditing ? (
              /* existing textarea */
            ) : (
              /* existing text div */
            )}
```
(Keep the existing textarea and text-div branches as the `else` arms.)

- [ ] **Step 6: Style the image card**

Append to `src/shapes/card.css`:
```css
.elves-card__image {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  display: block;
  border-radius: 6px;
}
```

- [ ] **Step 7: Add upload + create-card to the app**

In `src/App.tsx`, import and add the creation flow. Imports:
```tsx
import { useRef } from 'react'
import { makeImageSourceCardProps } from './model/cards'
import { uploadAsset } from './client/assets'
```
Add `addImageCard` inside the component (alongside `addCard`):
```tsx
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addImageCard = async (ed: Editor, file: File, point?: { x: number; y: number }) => {
    let aspect = 0.7
    try {
      const bmp = await createImageBitmap(file)
      if (bmp.width > 0) aspect = bmp.height / bmp.width
      bmp.close?.()
    } catch { /* keep default aspect */ }
    const w = 280
    const h = Math.max(80, Math.round(w * aspect))
    const assetId = await uploadAsset(file)
    const at = point ?? ed.getViewportPageBounds().center
    const id = createShapeId()
    ed.createShape<CardShape>({
      id, type: 'card', x: at.x - w / 2, y: at.y - h / 2,
      props: { ...makeImageSourceCardProps(assetId), w, h },
    })
    ed.select(id)
  }
```
In `handleMount`, after the store listener + realtime wiring, register the drop handler (verify the API first):
```tsx
    ed.registerExternalContentHandler('files', async ({ files, point }) => {
      for (const file of files) {
        if (file.type.startsWith('image/')) await addImageCard(ed, file, point)
      }
    })
```
Add the button + hidden input to the toolbar JSX (next to `+ Prose` / `+ Source`):
```tsx
        <button data-testid="new-image" onClick={() => fileInputRef.current?.click()}>+ Image</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          data-testid="image-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && editor) addImageCard(editor, file)
            e.target.value = ''
          }}
        />
```

- [ ] **Step 8: Run the e2e to verify it passes**

Run: `rm -f .e2e/canvas.json && npm run e2e -- e2e/images.spec.ts`
Expected: PASS — the image renders and survives reload.

- [ ] **Step 9: Run the whole suite**

Run: `npm test && npm run typecheck && rm -f .e2e/canvas.json && npm run e2e`
Expected: all unit tests, `tsc --noEmit`, and all Playwright specs green.

- [ ] **Step 10: Commit**

```bash
git add src/client/assets.ts src/App.tsx src/shapes/CardShapeUtil.tsx src/shapes/card.css e2e/fixtures/handwriting.png e2e/images.spec.ts
git commit -m "feat: add + render image source cards (upload, button, drop)"
```

---

## Phase 3a Definition of Done
- A "+ Image" button (and dragging an image onto the canvas) creates an **image source card** that renders the image at its aspect ratio.
- The image is stored as a file under `data/assets/`; `canvas.json` holds only the `assetId`.
- The card moves/resizes like any card and **persists across reload** (image reloads from `GET /assets/:id`).
- Existing Phase 1/2 canvases still load (migration).
- `npm test`, `npm run typecheck`, and `npm run e2e` are all green.
- No Claude / change-set / MCP changes (that's 3b).

## Deferred to Phase 3b
`create_source_card` op + applier + guard update, `origin: 'transcribed'`, `assetPath` in the `read_canvas` digest, the MCP tool, and the transcription skill workflow.

## Self-Review (done during authoring)
- **Spec coverage:** image source card (`sourceKind:'image'`, `origin:'image'`, `assetId`, empty text) (§4) → Tasks 2, 3; local-first file storage + `POST /assets`/`GET /assets/:id` + traversal-safety (§5) → Task 1; `assetId` prop + migration (§4, §8) → Task 2; drag/drop + aspect-fit sizing + rendering (§4) → Task 3; "no Claude in 3a" → nothing here touches change-sets/MCP; `data/assets` portable folder (§5) → Task 1. Deferred 3b items (`create_source_card`, `transcribed`, `assetPath`, MCP) correctly absent.
- **Placeholder scan:** none; every code/test step is complete (the `/* existing … */` markers in Step 5 point at code already in the file, not new code to invent).
- **Type consistency:** `assetId: string \| null` identical in `types.ts` (Task 2), the shape props/validator (Task 2), and rendering (Task 3); `makeImageSourceCardProps(assetId): CardProps` consistent across Tasks 2–3; `uploadAsset`/`assetUrl` signatures consistent across the client and App; `assetsDir`/`saveAsset`/`resolveAssetPath` consistent across `assets.ts` and `app.ts`.
