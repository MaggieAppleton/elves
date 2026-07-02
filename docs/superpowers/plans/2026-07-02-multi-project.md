# Multi-project Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution chosen — the feature is tightly coupled and best held in one context). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Elves first-class projects — create, list, switch, rename — with per-project storage and a required `project` target on every MCP tool plus a `list_projects` discovery tool.

**Architecture:** One Express server + one MCP process, made project-scoped by an `id`. The server holds a `dataRoot` (`data/`) and derives per-project paths (`data/projects/<id>/{project.json,canvas.json,assets/}`). WebSocket broadcasts are tagged with the project id; the client applies only its current project's changes. MCP tools take a required `project` string.

**Tech Stack:** TypeScript, Express 4, `ws`, tldraw 3, React 18, Vitest + supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-02-multi-project-design.md`

---

## File Structure

**New:**
- `server/projects.ts` — project registry + path derivation + create/rename/list/get. One responsibility: the projects model on disk.
- `server/migrate.ts` — one-time legacy `canvas.json` → `projects/my-first-essay/` migration.
- `src/components/ProjectSwitcher.tsx` — toolbar dropdown UI (list / switch / new / rename).
- `tests/server/projects.test.ts`, `tests/server/migrate.test.ts` — registry + migration unit tests.

**Modified:**
- `src/model/changeset.ts` — add `referencedCardIds(cs)` helper.
- `server/app.ts` — `createServer(dataRoot, onChangeSet)`; project-scoped routes; changeset cross-check.
- `server/realtime.ts` — `broadcast(projectId, changeSet)` sends `{projectId, changeSet}`.
- `server/index.ts` — `dataRoot` from `ELVES_DATA`; run migration at startup.
- `server/assets.ts` — unchanged (already takes an assets dir); path now supplied per project.
- `mcp/elvesClient.ts` — project-scoped URLs + `listProjects`.
- `mcp/tools.ts` — each tool takes `projectId`; add `listProjectsTool`.
- `mcp/index.ts` — required `project` param on each tool; `list_projects` tool; updated descriptions.
- `src/client/persistence.ts` — project-scoped canvas load/save + projects API.
- `src/client/realtime.ts` — parse `{projectId, changeSet}`.
- `src/client/assets.ts` — `uploadAsset(projectId, file)`, `assetUrl(projectId, assetId)`.
- `src/App.tsx` — project state, switcher wiring, per-project mount via `key`, realtime filter.
- Tests: `tests/server/api.test.ts`, `tests/server/changeset.test.ts`, `tests/server/assets.test.ts`, `tests/mcp/tools.test.ts`, `tests/mcp/server.test.ts`, `tests/client/persistence.test.ts`, and `e2e/*` updated to scoped routes.

**Key type shared across tasks:**
```ts
export interface Project { id: string; name: string; createdAt: string }
```
`id` = folder name (slug, unique, filesystem-safe). `name` = editable display label. `createdAt` = ISO string.

---

## Phase 1 — Project registry, paths, migration

### Task 1: `referencedCardIds` helper

**Files:** Modify `src/model/changeset.ts`; Test `tests/model/changeset.test.ts`

- [ ] **Step 1: Write failing test** (append to `tests/model/changeset.test.ts`)
```ts
import { referencedCardIds } from '../../src/model/changeset'

test('referencedCardIds collects existing-card references, ignores create_source_card', () => {
  const cs = { id: 'x', author: 'claude' as const, ops: [
    { kind: 'add_comment' as const, cardId: 'shape:a', comment: { type: null, text: 'hi' } },
    { kind: 'merge_sources' as const, cardIds: ['shape:b', 'shape:c'] },
    { kind: 'move_cards' as const, moves: [{ cardId: 'shape:d', x: 1, y: 2 }] },
    { kind: 'create_source_card' as const, text: 't', x: 0, y: 0 },
  ] }
  expect(referencedCardIds(cs).sort()).toEqual(['shape:a', 'shape:b', 'shape:c', 'shape:d'])
})
```
- [ ] **Step 2: Run — expect FAIL** `npx vitest run tests/model/changeset.test.ts` (referencedCardIds not exported)
- [ ] **Step 3: Implement** (append to `src/model/changeset.ts`)
```ts
/** Card ids an op references as an EXISTING card (not create_source_card, which mints a new id). */
export function referencedCardIds(cs: ChangeSet): string[] {
  const ids: string[] = []
  for (const op of cs.ops) {
    if (op.kind === 'add_comment') ids.push(op.cardId)
    else if (op.kind === 'merge_sources') ids.push(...op.cardIds)
    else if (op.kind === 'move_cards') ids.push(...op.moves.map((m) => m.cardId))
  }
  return ids
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(model): add referencedCardIds helper"`

### Task 2: Project registry (`server/projects.ts`)

**Files:** Create `server/projects.ts`; Test `tests/server/projects.test.ts`

- [ ] **Step 1: Write failing tests** (`tests/server/projects.test.ts`) — cover: create returns slug id + trimmed name; duplicate name → `-2` suffix; listProjects sorted by createdAt; getProject returns null for unknown/invalid id; rename changes name, keeps id; invalid id rejected by `isValidId`; path-traversal id (`../evil`) → `projectDir` returns null.
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, listProjects, getProject, renameProject, isValidId, slugify, projectDir } from '../../server/projects'

let dirs: string[] = []
async function root() { const d = await fs.mkdtemp(join(tmpdir(), 'elves-proj-')); dirs.push(d); return d }
afterEach(async () => { await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))); dirs = [] })

test('slugify makes a filesystem-safe id', () => {
  expect(slugify('Climate Essay!')).toBe('climate-essay')
  expect(slugify('   ')).toBe('project')
})
test('isValidId rejects traversal and unsafe ids', () => {
  expect(isValidId('climate-essay')).toBe(true)
  expect(isValidId('../evil')).toBe(false)
  expect(isValidId('.hidden')).toBe(false)
  expect(isValidId('Bad Id')).toBe(false)
})
test('projectDir returns null for an unsafe id', async () => {
  const d = await root()
  expect(projectDir(d, '../evil')).toBeNull()
})
test('create then list round-trips; duplicate name gets a suffix', async () => {
  const d = await root()
  const a = await createProject(d, 'Climate Essay', '2026-07-02T10:00:00.000Z')
  const b = await createProject(d, 'Climate Essay', '2026-07-02T11:00:00.000Z')
  expect(a.id).toBe('climate-essay')
  expect(b.id).toBe('climate-essay-2')
  expect(a.name).toBe('Climate Essay')
  const list = await listProjects(d)
  expect(list.map((p) => p.id)).toEqual(['climate-essay', 'climate-essay-2'])
})
test('getProject returns null for unknown id', async () => {
  const d = await root()
  expect(await getProject(d, 'nope')).toBeNull()
})
test('rename changes name, keeps id', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  const renamed = await renameProject(d, 'draft', 'Final Draft')
  expect(renamed).toMatchObject({ id: 'draft', name: 'Final Draft' })
  expect((await getProject(d, 'draft'))?.name).toBe('Final Draft')
})
test('createProject rejects a blank name', async () => {
  const d = await root()
  await expect(createProject(d, '   ', 'now')).rejects.toThrow()
})
test('listProjects on a missing root returns []', async () => {
  const d = await root()
  expect(await listProjects(d)).toEqual([])
})
```
- [ ] **Step 2: Run — expect FAIL** `npx vitest run tests/server/projects.test.ts`
- [ ] **Step 3: Implement** `server/projects.ts`:
```ts
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

export interface Project { id: string; name: string; createdAt: string }

export class ProjectError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export function projectsRoot(dataRoot: string): string { return join(dataRoot, 'projects') }

export function isValidId(id: string): boolean {
  return !!id && id === basename(id) && !id.startsWith('.') && !id.includes('..') &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
}
export function projectDir(dataRoot: string, id: string): string | null {
  return isValidId(id) ? join(projectsRoot(dataRoot), id) : null
}
export function canvasPathFor(dataRoot: string, id: string): string | null {
  const dir = projectDir(dataRoot, id); return dir && join(dir, 'canvas.json')
}
export function assetsDirFor(dataRoot: string, id: string): string | null {
  const dir = projectDir(dataRoot, id); return dir && join(dir, 'assets')
}
export function slugify(name: string): string {
  const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return s || 'project'
}

export async function listProjects(dataRoot: string): Promise<Project[]> {
  let entries: string[]
  try { entries = await fs.readdir(projectsRoot(dataRoot)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const out: Project[] = []
  for (const id of entries) {
    try {
      const meta = JSON.parse(await fs.readFile(join(projectsRoot(dataRoot), id, 'project.json'), 'utf8')) as Project
      out.push({ id, name: meta.name, createdAt: meta.createdAt })
    } catch { /* skip non-project dirs / unreadable meta */ }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return out
}
export async function getProject(dataRoot: string, id: string): Promise<Project | null> {
  if (!isValidId(id)) return null
  try {
    const meta = JSON.parse(await fs.readFile(join(projectsRoot(dataRoot), id, 'project.json'), 'utf8')) as Project
    return { id, name: meta.name, createdAt: meta.createdAt }
  } catch { return null }
}
async function uniqueId(dataRoot: string, base: string): Promise<string> {
  const taken = new Set((await listProjects(dataRoot)).map((p) => p.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) { const c = `${base}-${n}`; if (!taken.has(c)) return c }
}
export async function createProject(dataRoot: string, name: string, createdAt: string): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  const id = await uniqueId(dataRoot, slugify(trimmed))
  const dir = join(projectsRoot(dataRoot), id)
  await fs.mkdir(dir, { recursive: true })
  const meta: Project = { id, name: trimmed, createdAt }
  await fs.writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}
export async function renameProject(dataRoot: string, id: string, name: string): Promise<Project> {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('name required', 400)
  const proj = await getProject(dataRoot, id)
  if (!proj) throw new ProjectError('unknown project', 404)
  const updated: Project = { ...proj, name: trimmed }
  await fs.writeFile(join(projectsRoot(dataRoot), id, 'project.json'), JSON.stringify(updated, null, 2), 'utf8')
  return updated
}
```
Note: a new project has no `canvas.json` until first save; `readCanvas` already returns `EMPTY_CANVAS` for a missing file, and `saveAsset` creates `assets/` lazily.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(server): project registry (create/list/get/rename, slug, path guards)"`

### Task 3: Legacy migration (`server/migrate.ts`)

**Files:** Create `server/migrate.ts`; Test `tests/server/migrate.test.ts`

- [ ] **Step 1: Write failing tests** — legacy `canvas.json` (+ `assets/`) moves into `projects/my-first-essay/`; idempotent (existing `projects/` short-circuits); fresh install (no legacy, no projects) leaves no `projects/` dir.
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateLegacyCanvas } from '../../server/migrate'
import { listProjects } from '../../server/projects'

let dirs: string[] = []
async function root() { const d = await fs.mkdtemp(join(tmpdir(), 'elves-mig-')); dirs.push(d); return d }
afterEach(async () => { await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))); dirs = [] })

test('migrates a legacy canvas + assets into my-first-essay', async () => {
  const d = await root()
  await fs.writeFile(join(d, 'canvas.json'), JSON.stringify({ document: { store: {} }, session: null }), 'utf8')
  await fs.mkdir(join(d, 'assets')); await fs.writeFile(join(d, 'assets', 'x.png'), 'bytes')
  await migrateLegacyCanvas(d, '2026-07-02T10:00:00.000Z')
  const list = await listProjects(d)
  expect(list).toEqual([{ id: 'my-first-essay', name: 'My first essay', createdAt: '2026-07-02T10:00:00.000Z' }])
  expect(await fs.readFile(join(d, 'projects', 'my-first-essay', 'assets', 'x.png'), 'utf8')).toBe('bytes')
  await expect(fs.stat(join(d, 'canvas.json'))).rejects.toThrow() // moved, not copied
})
test('is idempotent when projects/ already exists', async () => {
  const d = await root()
  await fs.mkdir(join(d, 'projects'), { recursive: true })
  await fs.writeFile(join(d, 'canvas.json'), '{}', 'utf8')
  await migrateLegacyCanvas(d, 'now')
  expect(await listProjects(d)).toEqual([])
  await fs.stat(join(d, 'canvas.json')) // untouched
})
test('fresh install creates no projects/ dir', async () => {
  const d = await root()
  await migrateLegacyCanvas(d, 'now')
  await expect(fs.stat(join(d, 'projects'))).rejects.toThrow()
})
```
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** `server/migrate.ts`:
```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot, Project } from './projects'

/** One-time: move a legacy data/canvas.json (+ assets/) into projects/my-first-essay/.
 *  Idempotent — a present projects/ short-circuits; a fresh install does nothing. */
export async function migrateLegacyCanvas(dataRoot: string, createdAt: string): Promise<void> {
  try { await fs.stat(projectsRoot(dataRoot)); return }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const legacy = join(dataRoot, 'canvas.json')
  try { await fs.stat(legacy) } catch { return }
  const dir = join(projectsRoot(dataRoot), 'my-first-essay')
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(legacy, join(dir, 'canvas.json'))
  try { await fs.rename(join(dataRoot, 'assets'), join(dir, 'assets')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const meta: Project = { id: 'my-first-essay', name: 'My first essay', createdAt }
  await fs.writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
}
```
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(server): one-time legacy canvas migration"`

---

## Phase 2 — Project-scoped server API + real-time tagging

### Task 4: Real-time broadcast tagging

**Files:** Modify `server/realtime.ts`; Test covered via api/mcp tests in Task 5/8.

- [ ] **Step 1: Change `broadcast` signature** — `broadcast(projectId: string, changeSet: ChangeSet)` sends `JSON.stringify({ projectId, changeSet })`.
- [ ] **Step 2: Typecheck** `npx tsc --noEmit` (expect errors at call sites — fixed in Task 5). Commit with Task 5.

### Task 5: Project-scoped server routes + cross-check

**Files:** Modify `server/app.ts`; Test `tests/server/api.test.ts`, `tests/server/changeset.test.ts`, `tests/server/assets.test.ts`

- [ ] **Step 1: Rewrite `tests/server/api.test.ts`** — `appWithTmp()` now returns `createServer(dataRoot)` where `dataRoot` is the mkdtemp dir. Tests:
  - `GET /projects` empty → `[]`.
  - `POST /projects {name:'Essay'}` → `{id:'essay',name:'Essay',createdAt:<string>}`; then `GET /projects` lists it.
  - `PATCH /projects/essay {name:'Renamed'}` → name updated.
  - `GET /projects/essay/canvas` before save → `{document:null,session:null}`.
  - `POST /projects/essay/canvas` then GET round-trips.
  - Scoped routes on unknown id → `404`.
  - `POST /projects {name:''}` → `400`.
```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'

let dirs: string[] = []
async function appWithTmp() { const d = await fs.mkdtemp(join(tmpdir(), 'elves-api-')); dirs.push(d); return createServer(d) }
afterEach(async () => { await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))); dirs = [] })

test('projects start empty, create + list', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects')).body).toEqual([])
  const created = await request(app).post('/projects').send({ name: 'Essay' })
  expect(created.status).toBe(200)
  expect(created.body).toMatchObject({ id: 'essay', name: 'Essay' })
  expect(typeof created.body.createdAt).toBe('string')
  expect((await request(app).get('/projects')).body).toHaveLength(1)
})
test('rename updates the display name', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Draft' })
  const r = await request(app).patch('/projects/draft').send({ name: 'Final' })
  expect(r.body).toMatchObject({ id: 'draft', name: 'Final' })
})
test('canvas round-trips within a project', async () => {
  const app = await appWithTmp()
  await request(app).post('/projects').send({ name: 'Essay' })
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual({ document: null, session: null })
  const snap = { document: { schema: 1, records: [] }, session: null }
  expect((await request(app).post('/projects/essay/canvas').send(snap)).body).toEqual({ ok: true })
  expect((await request(app).get('/projects/essay/canvas')).body).toEqual(snap)
})
test('scoped route on unknown project → 404', async () => {
  const app = await appWithTmp()
  expect((await request(app).get('/projects/ghost/canvas')).status).toBe(404)
})
test('blank name → 400', async () => {
  const app = await appWithTmp()
  expect((await request(app).post('/projects').send({ name: '' })).status).toBe(400)
})
```
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Rewrite `server/app.ts`** — signature `createServer(dataRoot: string, onChangeSet?: (projectId: string, cs: ChangeSet) => void)`. Add project routes (`GET/POST /projects`, `PATCH /projects/:id`) using `server/projects.ts` (map `ProjectError` → its status). Scope canvas/cards/changeset/assets under `/projects/:id/...` with a `requireProject` guard returning the canvas path (`canvasPathFor`) or `404`; assets use `assetsDirFor`. Changeset route becomes async + `wrap`ped and adds cross-check:
```ts
const missing = referencedCardIds(req.body).filter((id) => !cardIds.has(id))
if (missing.length) { res.status(409).json({ error: 'card not in project', missing }); return }
onChangeSet?.(req.params.id, req.body)
```
where `cardIds = new Set(snapshotToCards(await readCanvas(canvasPath)).map((c) => c.id))`. Keep `isChangeSet`→400 and `changeSetWritesText`→403 checks first.
- [ ] **Step 4: Update `tests/server/changeset.test.ts` and `tests/server/assets.test.ts`** to scoped routes (create a project first; POST to `/projects/<id>/changeset` and `/projects/<id>/assets`). Add a changeset test: a move referencing a non-existent card → `409`; prose-write op still → `403`.
- [ ] **Step 5: Run — expect PASS** `npx vitest run tests/server`
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(server): project-scoped routes + changeset cross-check + tagged broadcast"`

### Task 6: Startup wiring (`server/index.ts`)

**Files:** Modify `server/index.ts`

- [ ] **Step 1: Implement** — `const dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')`; `await migrateLegacyCanvas(dataRoot, new Date().toISOString())` before `listen`; `createServer(dataRoot, broadcast)`; log `dataRoot`. Wrap in an async `main()`.
- [ ] **Step 2: Typecheck** `npx tsc --noEmit` — expect PASS for server (client/mcp fixed in later phases; run scoped: it should already be clean for server files).
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(server): dataRoot + startup migration"`

---

## Phase 3 — MCP tools

### Task 7: elvesClient + tools take `projectId`

**Files:** Modify `mcp/elvesClient.ts`, `mcp/tools.ts`; Test `tests/mcp/tools.test.ts`

- [ ] **Step 1: Update `tests/mcp/tools.test.ts`** — `liveElves()` builds `createServer(dataRoot, broadcast)` with an mkdtemp `dataRoot`, then `POST /projects {name:'Essay'}` so `essay` exists; WS message is now `{projectId, changeSet}`; every tool call passes `'essay'`; add a `listProjectsTool` test.
```ts
await addCommentTool(base, 'essay', { cardId: 'shape:a', text: 'no source', type: 'needs-evidence' })
const { projectId, changeSet } = await received
expect(projectId).toBe('essay')
expect(changeSet.ops).toEqual([{ kind: 'add_comment', cardId: 'shape:a', comment: { type: 'needs-evidence', text: 'no source' } }])
```
  Note: `add_comment` referencing `shape:a` will hit the cross-check. For the broadcast test, first save a canvas containing `shape:a` to `/projects/essay/canvas` (as `readCanvasTool` test already builds such a snapshot), OR assert the tool throws on a missing card. Prefer: save a snapshot with the referenced card, then assert broadcast. For `createSourceCardTool` (no existing-card ref) no pre-seed needed.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** `mcp/elvesClient.ts` — add `projectId` param, build `/projects/${encodeURIComponent(projectId)}/...` URLs, map `404`→`Error('unknown project')`, surface changeset error body; add `listProjects(baseUrl)`.
- [ ] **Step 4: Implement** `mcp/tools.ts` — thread `projectId` through `readCanvasTool`, `addCommentTool`, `mergeSourcesTool`, `moveCardsTool`, `createSourceCardTool`; add `listProjectsTool(baseUrl)`.
- [ ] **Step 5: Run — expect PASS** `npx vitest run tests/mcp`
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(mcp): project-scoped client + tools"`

### Task 8: MCP server tool schemas (`mcp/index.ts`)

**Files:** Modify `mcp/index.ts`; Test `tests/mcp/server.test.ts`

- [ ] **Step 1: Update `tests/mcp/server.test.ts`** — assert each of the five tools declares a required `project` and a `list_projects` tool is registered. (Match existing test style — inspect the registered tools/schema.)
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — add `project: z.string()` to each tool's input schema; pass `project` into the tool call; register `list_projects` (`{}` input) returning `JSON.stringify(await listProjectsTool(baseUrl))`. Update descriptions: each mutating tool notes *"`project` is the project id from `list_projects`; if you don't know it, call `list_projects` and confirm with the user — never guess."*
- [ ] **Step 4: Run — expect PASS**; `npx tsc --noEmit` (mcp clean).
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(mcp): required project param + list_projects tool"`

---

## Phase 4 — Client data layer

### Task 9: persistence / realtime / assets scoping

**Files:** Modify `src/client/persistence.ts`, `src/client/realtime.ts`, `src/client/assets.ts`; Test `tests/client/persistence.test.ts`

- [ ] **Step 1: Update `tests/client/persistence.test.ts`** — `loadCanvas(projectId)`/`saveCanvas(projectId, snap)` hit `/projects/<id>/canvas`; add `listProjects()`, `createProject(name)`, `renameProject(id,name)` hitting `/projects`. (Follow the file's existing fetch-mock pattern.)
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**:
  - `persistence.ts`: `loadCanvas(projectId)`, `saveCanvas(projectId, snapshot)` → `/projects/${projectId}/canvas`; add `listProjects()`, `createProject(name)`, `renameProject(id, name)`; re-export `Project` type; keep `debounce`.
  - `realtime.ts`: `connectRealtime(onMessage: (projectId: string, cs: ChangeSet) => void)` parsing `{projectId, changeSet}`.
  - `assets.ts`: `uploadAsset(projectId, file)` → `/projects/${projectId}/assets`; `assetUrl(projectId, assetId)` → `/projects/${projectId}/assets/${assetId}`.
- [ ] **Step 4: Run — expect PASS** `npx vitest run tests/client`
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(client): project-scoped data layer"`

---

## Phase 5 — UI switcher

### Task 10: ProjectSwitcher component

**Files:** Create `src/components/ProjectSwitcher.tsx`

- [ ] **Step 1: Implement** a controlled dropdown. Props:
```ts
interface Props {
  projects: Project[]
  currentId: string | null
  onSwitch: (id: string) => void
  onCreate: () => void   // parent prompts + creates
  onRename: () => void   // parent prompts + renames current
}
```
Renders a toolbar button showing the current project name + caret; opening reveals the list (check on current), a divider, `+ New project…`, and `Rename current project…`. Close on outside-click / Escape. Style with existing `elves-*` classes / `theme.css`; add minimal styles as needed. `data-testid`s: `project-switcher`, `project-option-<id>`, `project-new`, `project-rename`.
- [ ] **Step 2: Typecheck** `npx tsc --noEmit`
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(ui): ProjectSwitcher dropdown"`

### Task 11: Wire App to projects

**Files:** Modify `src/App.tsx`

- [ ] **Step 1: Implement** project state + wiring:
  - State: `projects: Project[] | null` (null = loading), `currentProjectId: string | null`. Refs: `editorRef`, `projectIdRef` (kept in sync via effect).
  - Mount effect: `listProjects()` → set list; pick `localStorage['elves:lastProject']` if present in list else first; if list empty leave `currentProjectId` null.
  - Realtime effect (once): `connectRealtime((projectId, cs) => { if (projectId !== projectIdRef.current) return; const ed = editorRef.current; if (!ed) return; applyChangeSet(ed, cs); saveCanvas(projectId, getSnapshot(ed.store)).catch(...) })`; return its disconnect.
  - Render: if `projects === null` → nothing/spinner; if empty → centered "Create your first project" button (calls create flow); else render toolbar (with `<ProjectSwitcher/>`) + `<Tldraw key={currentProjectId} onMount={handleMount} />`.
  - `handleMount(ed)`: set `editorRef`/`editor`; `loadCanvas(currentProjectId)` → `loadSnapshot` if `document`; then wire debounced autosave `saveCanvas(currentProjectId, …)` and the image drop handler (`uploadAsset(currentProjectId, file)`).
  - `switchProject(id)`: if same, no-op; flush current (`await saveCanvas(currentProjectId, getSnapshot(editor.store))` if editor) ; `localStorage.setItem('elves:lastProject', id)`; `setCurrentProjectId(id)` (key change remounts + reloads).
  - `createFlow()`: `const name = window.prompt('New project name')`; if name → `createProject(name)` → refresh list → `switchProject(new.id)`.
  - `renameFlow()`: `const name = window.prompt('Rename project', current.name)`; if name → `renameProject(currentId, name)` → refresh list.
  - `addImageCard` / image input `onChange` use `currentProjectId` for `uploadAsset`.
- [ ] **Step 2: Typecheck** `npx tsc --noEmit`
- [ ] **Step 3: Manual smoke** `npm run dev:all`, verify create/switch/rename + autosave persist across reload (self-check; e2e in Phase 6).
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(ui): multi-project switcher wired into App"`

---

## Phase 6 — E2E + green suite

### Task 12: Update / add E2E

**Files:** Modify `e2e/*.spec.ts`, `playwright.config.ts` if it seeds `.e2e/canvas.json`

- [ ] **Step 1:** Inspect `playwright.config.ts` + `.e2e/` seeding. Update the harness so the server starts with an `ELVES_DATA` temp dir seeded with a project (or the app auto-creates one). Existing specs (`cards`, `comments`, `images`, `changes`, `claude-tools`, `transcribe`) must first ensure a project exists/open.
- [ ] **Step 2: Add `e2e/projects.spec.ts`** — create a project via the switcher, add a card, create a second project (canvas is empty), switch back (first card still there), rename a project (name updates in switcher).
- [ ] **Step 3: Run** `npm run e2e` — expect PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "test(e2e): multi-project flows + scoped harness"`

### Task 13: Full green + docs

- [ ] **Step 1:** `npx vitest run` (all unit/integration) — PASS.
- [ ] **Step 2:** `npx tsc --noEmit` — PASS.
- [ ] **Step 3:** `npm run e2e` — PASS.
- [ ] **Step 4:** Update `README.md` — projects section (create/switch/rename), new `data/projects/<id>/…` layout, MCP tools now require `project` + `list_projects`, `.mcp.json`/env note (`ELVES_DATA`). Update `skill/elves-canvas.md` for the `project` param + `list_projects`.
- [ ] **Step 5: Commit** `git add -A && git commit -m "docs: multi-project usage + MCP project targeting"`

---

## Self-Review (author)

- **Spec coverage:** create/list/switch/rename → Tasks 2,5,10,11; MCP required `project` + `list_projects` → Tasks 7,8; cross-check → Tasks 1,5; per-project folders → Task 2; migration → Tasks 3,6; real-time tagging + client filter → Tasks 4,5,9,11; UI switcher → Tasks 10,11; migration/README → Tasks 3,13. ✓ All spec sections mapped.
- **Type consistency:** `Project {id,name,createdAt}` used identically across server/projects, migrate, client persistence, ProjectSwitcher. `broadcast(projectId, cs)` matches `connectRealtime((projectId, cs)=>…)` and the `{projectId, changeSet}` wire shape. `canvasPathFor`/`assetsDirFor`/`projectDir` names consistent. Tool fns all take `(baseUrl, projectId, …)`. ✓
- **Placeholders:** none — every task has concrete code or an exact, unambiguous change + command. ✓
```
