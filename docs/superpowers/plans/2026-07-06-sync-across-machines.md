# Sync Projects Across Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one user run Elves on two Macs and keep all projects in sync, by relocating the data root to a Syncthing-synced folder and adding light guardrails.

**Architecture:** No new subsystem. Relocate the data root out of the repo via a per-machine gitignored `.env` (loaded by `dotenv` in the server entry only). Syncthing keeps that folder identical P2P. A small startup scan warns if Syncthing conflict files appear. All changes are additive and behind an env var that defaults to today's behavior.

**Tech Stack:** Node 23, TypeScript, Express, Vitest, `dotenv`, Syncthing (external, ops).

---

## File Structure

- **Create** `server/conflicts.ts` — pure `findSyncConflicts(dataRoot)` + `warnOnSyncConflicts(dataRoot, log?)`. One responsibility: detect and report Syncthing conflict files.
- **Create** `tests/server/conflicts.test.ts` — unit tests for the finder.
- **Create** `.env.example` — documents `ELVES_DATA` + existing env vars.
- **Create** `docs/syncthing.stignore` — template the user copies to `<data-root>/.stignore`.
- **Modify** `server/index.ts` — `import 'dotenv/config'` at top; call `warnOnSyncConflicts` in `main()`.
- **Modify** `.gitignore` — add `.env` (keep `.env.example` tracked).
- **Modify** `package.json` — add `dotenv` dependency (via `npm install`).
- **Modify** `README.md` — add "Syncing across machines" section.

---

## Task 1: Add `dotenv` and load it in the server entry

**Files:**
- Modify: `package.json` (dependency added by npm)
- Modify: `server/index.ts:1` (add import)

- [ ] **Step 1: Install dotenv**

Run: `npm install dotenv`
Expected: `dotenv` appears under `dependencies` in `package.json`; lockfile updated.

- [ ] **Step 2: Load dotenv at the very top of the server entry**

In `server/index.ts`, make the FIRST line (above all other imports, so the env is
populated before anything reads `process.env`):

```ts
import 'dotenv/config'
import http from 'node:http'
```

(The existing `import http from 'node:http'` stays; just add the dotenv line above it.)

- [ ] **Step 3: Verify it loads and defaults are unchanged**

Run: `npm run typecheck`
Expected: no type errors.

Run: `printf 'ELVES_DATA=%s/elves-env-test\n' "$TMPDIR" > .env && npx tsx -e "import('dotenv/config').then(()=>console.log(process.env.ELVES_DATA))" && rm .env`
Expected: prints a path ending in `/elves-env-test`, confirming `.env` is read.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server/index.ts
git commit -m "feat(server): load .env via dotenv so ELVES_DATA can point at a synced folder"
```

---

## Task 2: Ship `.env.example` and gitignore `.env`

**Files:**
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Create `.env.example`**

```dotenv
# Copy this file to `.env` (per machine — not committed) and set an absolute path.
# ELVES_DATA is the data root that holds `projects/<id>/…` — all your projects.
# Point it at a folder you sync between machines with Syncthing (see README:
# "Syncing across machines"). Absolute path; the two machines may differ.
ELVES_DATA=/Users/you/Elves

# Server port (default 5199).
# PORT=5199

# Where the web app looks for the server (default http://localhost:5199).
# VITE_SERVER_URL=http://localhost:5199

# Ollama endpoint + model used for local card summaries (optional).
# OLLAMA_HOST=http://localhost:11434
# OLLAMA_MODEL=llama3.2
```

- [ ] **Step 2: Gitignore `.env` but keep `.env.example` tracked**

In `.gitignore`, add these two lines at the end:

```gitignore
.env
!.env.example
```

- [ ] **Step 3: Verify `.env` is ignored and `.env.example` is not**

Run: `printf 'ELVES_DATA=/tmp/x\n' > .env && git check-ignore .env && git status --porcelain .env.example && rm .env`
Expected: prints `.env` (ignored) and `?? .env.example` (tracked/untracked, not ignored).

- [ ] **Step 4: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add .env.example and gitignore per-machine .env"
```

---

## Task 3: Sync-conflict finder (TDD)

**Files:**
- Create: `server/conflicts.ts`
- Test: `tests/server/conflicts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/conflicts.test.ts`:

```ts
import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findSyncConflicts, warnOnSyncConflicts } from '../../server/conflicts'

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

test('no projects dir yet returns no conflicts', async () => {
  const d = await tmpDir()
  expect(await findSyncConflicts(d)).toEqual([])
})

test('a clean projects tree returns no conflicts', async () => {
  const d = await tmpDir()
  await fs.mkdir(join(d, 'projects', 'p1', 'assets'), { recursive: true })
  await fs.writeFile(join(d, 'projects', 'p1', 'canvas.json'), '{}')
  await fs.writeFile(join(d, 'projects', 'p1', 'assets', 'a.png'), 'x')
  expect(await findSyncConflicts(d)).toEqual([])
})

test('finds sync-conflict files anywhere under projects, sorted', async () => {
  const d = await tmpDir()
  const p1 = join(d, 'projects', 'p1')
  const assets = join(p1, 'assets')
  await fs.mkdir(assets, { recursive: true })
  const conflictCanvas = join(p1, 'canvas.sync-conflict-20260706-120000-ABCDEF.json')
  const conflictAsset = join(assets, 'a.sync-conflict-20260706-120100-ABCDEF.png')
  await fs.writeFile(join(p1, 'canvas.json'), '{}')
  await fs.writeFile(conflictCanvas, '{}')
  await fs.writeFile(conflictAsset, 'x')
  expect(await findSyncConflicts(d)).toEqual([conflictAsset, conflictCanvas].sort())
})

test('warnOnSyncConflicts logs one summary + one line per conflict, and is silent when clean', async () => {
  const d = await tmpDir()
  const p1 = join(d, 'projects', 'p1')
  await fs.mkdir(p1, { recursive: true })
  await fs.writeFile(join(p1, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'), '{}')

  const lines: string[] = []
  await warnOnSyncConflicts(d, (m) => lines.push(m))
  expect(lines.length).toBe(2) // summary + one path
  expect(lines[0]).toMatch(/conflict/i)
  expect(lines[1]).toContain('canvas.sync-conflict-')

  const clean = await tmpDir()
  const cleanLines: string[] = []
  await warnOnSyncConflicts(clean, (m) => cleanLines.push(m))
  expect(cleanLines).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server/conflicts.test.ts`
Expected: FAIL — cannot resolve `../../server/conflicts`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/conflicts.ts`:

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot } from './projects'

/**
 * Syncthing writes a `<name>.sync-conflict-<date>-<time>-<device>.<ext>` file
 * next to the original whenever two machines edit the same file while offline —
 * it never loses either version, it just parks the loser under this name. This
 * marker string is the reliable way to recognize one.
 */
const CONFLICT_MARKER = '.sync-conflict-'

/**
 * Return absolute paths of every Syncthing conflict file anywhere under the
 * data root's `projects/` tree, sorted for stable output. Best-effort: a missing
 * projects dir (fresh install) yields an empty list rather than throwing.
 */
export async function findSyncConflicts(dataRoot: string): Promise<string[]> {
  const root = projectsRoot(dataRoot)
  let entries: string[]
  try {
    entries = await fs.readdir(root, { recursive: true })
  } catch {
    return []
  }
  return entries
    .filter((rel) => rel.includes(CONFLICT_MARKER))
    .map((rel) => join(root, rel))
    .sort()
}

/**
 * Log a clear, advisory warning if any Syncthing conflict files exist, so a
 * cross-machine divergence surfaces loudly at startup instead of hiding. Purely
 * informational — it never modifies or resolves anything, and never throws (a
 * startup diagnostic must not be able to stop the server booting).
 */
export async function warnOnSyncConflicts(
  dataRoot: string,
  log: (msg: string) => void = console.warn,
): Promise<void> {
  try {
    const conflicts = await findSyncConflicts(dataRoot)
    if (conflicts.length === 0) return
    log(
      `[elves] ⚠ Syncthing conflict files detected (${conflicts.length}). Your projects ` +
        `may have diverged across machines — review and resolve each, then delete it:`,
    )
    for (const path of conflicts) log(`[elves]   ${path}`)
  } catch {
    // Best-effort diagnostic: never block startup.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server/conflicts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/conflicts.ts tests/server/conflicts.test.ts
git commit -m "feat(server): detect Syncthing conflict files under the data root"
```

---

## Task 4: Warn about conflicts at server startup

**Files:**
- Modify: `server/index.ts` (import + call in `main()`)

- [ ] **Step 1: Import the helper**

In `server/index.ts`, add to the import block (near the other `./` imports):

```ts
import { warnOnSyncConflicts } from './conflicts'
```

- [ ] **Step 2: Call it during startup, before the server-ready log**

In `main()`, immediately after the two `await migrate…` lines and before
`const httpServer = http.createServer()`, add:

```ts
  // Surface any Syncthing cross-machine divergence loudly at boot (advisory only).
  await warnOnSyncConflicts(dataRoot)
```

- [ ] **Step 3: Verify typecheck and a manual boot warning**

Run: `npm run typecheck`
Expected: no errors.

Run:
```bash
D=$(mktemp -d) && mkdir -p "$D/projects/p1" && echo '{}' > "$D/projects/p1/canvas.sync-conflict-20260706-120000-ABCDEF.json" && ELVES_DATA="$D" PORT=5210 npx tsx server/index.ts & SRV=$!; sleep 2; kill $SRV; rm -rf "$D"
```
Expected: startup logs include a line containing `Syncthing conflict files detected (1)` and the conflict path.

- [ ] **Step 4: Run the full server test suite (no regressions)**

Run: `npx vitest run tests/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): warn at startup when Syncthing conflict files exist"
```

---

## Task 5: Ship the `.stignore` template

**Files:**
- Create: `docs/syncthing.stignore`

- [ ] **Step 1: Create the template**

Create `docs/syncthing.stignore`:

```gitignore
// Syncthing ignore file for the Elves data folder.
// Copy this to the ROOT of your synced data folder as `.stignore`
// (e.g. ~/Elves/.stignore) on each machine.

// The server writes atomically via a unique temp file it renames into place.
// Those temps are gone in milliseconds — telling Syncthing to ignore them
// avoids pointless sync churn and "file disappeared" scan errors.
*.tmp

// Keep everything else — including `.bak` / *.backup.json — so backups sync too.
```

- [ ] **Step 2: Verify it exists and matches the temp pattern**

Run: `grep -q '^\*\.tmp$' docs/syncthing.stignore && echo OK`
Expected: `OK` (confirms the pattern matches the `<path>.<pid>.<seq>.tmp` temps from `server/store.ts`).

- [ ] **Step 3: Commit**

```bash
git add docs/syncthing.stignore
git commit -m "docs: add Syncthing .stignore template for the data folder"
```

---

## Task 6: Document syncing in the README

**Files:**
- Modify: `README.md` (new section after "Configuration")

- [ ] **Step 1: Add the section**

In `README.md`, after the "Configuration" section (and before "Card summaries"),
insert:

```markdown
## Syncing across machines

Elves keeps every project as plain files under a single data root, so syncing to
another machine is just syncing that folder. This setup keeps the app fully
local-first (offline, instant load) on each machine — nothing goes to the cloud.

**One-time, per machine:**

1. **Pick a data folder outside the repo** — e.g. `~/Elves`. Move your existing
   projects into it: `mkdir -p ~/Elves && mv data/projects ~/Elves/`.
2. **Point the app at it.** Copy `.env.example` to `.env` and set an absolute path:
   `ELVES_DATA=/Users/<you>/Elves`. (`.env` is per-machine and gitignored; the two
   machines may use different paths.)
3. **Install [Syncthing](https://syncthing.net)** and add `~/Elves` as a shared
   folder, using the **same Folder ID** on both machines, then pair the two
   devices. Copy `docs/syncthing.stignore` to `~/Elves/.stignore` so Syncthing
   ignores the server's transient write-temps.

Syncthing then keeps the folder identical between your machines, peer-to-peer and
encrypted — no third party ever holds your writing.

**The one rule:** work on one machine at a time, and let sync settle (a few
seconds) before switching. Each project's `canvas.json` is a single file, so
editing the *same* project on both machines while offline can't auto-merge — but
Syncthing never loses either version: it parks the loser as a
`…sync-conflict-…` file. If that ever happens, the server prints a warning at
startup naming the files so you can review and delete them.
```

- [ ] **Step 2: Verify the section renders and links resolve**

Run: `grep -n "Syncing across machines" README.md`
Expected: prints the heading line once.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: explain syncing projects across machines with Syncthing"
```

---

## Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Unit + integration tests**

Run: `npm test`
Expected: PASS (including the new `tests/server/conflicts.test.ts`).

- [ ] **Step 3: Confirm a relocated data root actually serves**

Run:
```bash
D=$(mktemp -d) && mkdir -p "$D/projects" && ELVES_DATA="$D" PORT=5211 npx tsx server/index.ts & SRV=$!; sleep 2; curl -s localhost:5211/projects; echo; kill $SRV; rm -rf "$D"
```
Expected: server log shows `data: <tmp>`, and `/projects` returns a JSON array
(empty `[]` is fine) — proving the app reads/writes the relocated root.

- [ ] **Step 4: Final commit if anything is uncommitted**

```bash
git status --porcelain
```
Expected: clean. If not, commit the remainder with a descriptive message.

---

## Self-Review notes

- **Spec coverage:** relocate root (Tasks 1–2, 6) · `.env`+dotenv (Task 1–2) ·
  gitignore `.env` (Task 2) · `.stignore` template (Task 5) · startup conflict
  warning (Tasks 3–4) · README section (Task 6) · verification (Task 7). MCP entry
  intentionally untouched (uses `ELVES_URL` over HTTP — see spec §2).
- **Out of scope stays out:** no Tailscale/URL, no lock/heartbeat, no per-card
  file split, no realtime cross-machine collab.
- **Type consistency:** `findSyncConflicts(dataRoot: string): Promise<string[]>`
  and `warnOnSyncConflicts(dataRoot: string, log?)` used identically in Tasks 3–4.
