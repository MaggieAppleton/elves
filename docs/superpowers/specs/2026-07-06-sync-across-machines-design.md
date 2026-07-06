# Sync projects across machines with Syncthing

**Date:** 2026-07-06
**Status:** Approved design, ready for implementation plan

## Goal

Run the full local Elves app on two personal Macs (personal + work) and keep all
projects in sync between them, without giving up the app's local-first character
(offline, insta-load) and without putting any writing data in the code repo.

Constraints (from the brainstorm):

- **Single user, forever.** No auth, no multi-user concerns.
- **Multiple projects**, all of which must sync.
- **Local-first stays intact.** The app keeps running as a local server + browser
  client on each machine; offline and insta-load are preserved because nothing
  moves to the network.
- **Code repo stays clean.** No writing data on the app's GitHub repo (already true
  — `data/` is gitignored).
- **Keep it simple.** Minimal moving parts; mostly setup, not new subsystems.
- **Remote URL is explicitly deferred** to a later phase (see Out of Scope).

## Why this is low-risk

- **Saves are atomic.** `server/store.ts` writes to a unique temp file and then
  `fs.rename()`s it over `canvas.json`. On a single filesystem, rename is atomic,
  so any file-sync tool always sees a complete old-or-new file, never a torn write.
  This removes the main real-world failure mode of "just sync the folder."
- **The data root is already fully parameterized.** `server/index.ts:12` resolves
  `dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')`, and every path
  (`projects/<id>/canvas.json`, `assets/`, `project.json`) derives from that root.
  Relocating the data is a single env var, not a code change.
- **Existing safety net.** The store already keeps a rolling `.bak`, refuses to
  blank a real canvas, and treats empty/torn files as "missing." Sync layers on top
  of that rather than fighting it.

## Approach

Move the data root **out of the repo** into a dedicated per-machine folder (default
`~/Elves`), point `ELVES_DATA` at it on each machine, and let **Syncthing** keep
that one folder identical between the two machines, peer-to-peer.

### 1. Relocate the data root (out of the repo)

Today `data/` lives inside the checkout. Syncing it in place is fragile because the
project is often run from **git worktrees**, and each worktree is a separate
checkout with its own (gitignored, initially empty) `data/`. A stable per-machine
folder like `~/Elves` sidesteps the ambiguity: any checkout or worktree on a machine
uses the same synced data via `ELVES_DATA`.

- Recommended location: `~/Elves` (holds `projects/<id>/…`, mirroring the current
  `data/` layout).
- One-time migration per machine: move the existing `data/projects` contents into
  `~/Elves/projects` (documented in the README, done by hand — it's a folder move).

### 2. Config mechanism — gitignored `.env` + `dotenv`

`ELVES_DATA` must be an absolute path, and the two Macs may have different home
paths (different usernames). A committed value therefore can't work across both.

- Add `dotenv` as a dependency.
- Load it with a single `import 'dotenv/config'` at the top of the server entry
  (`server/index.ts`) and the MCP entry (`mcp/index.ts`, if it reads the data root
  directly rather than over HTTP — confirm during implementation).
- Ship a committed **`.env.example`** documenting `ELVES_DATA` (and the other
  existing env vars: `PORT`, `VITE_SERVER_URL`, `OLLAMA_HOST`, `OLLAMA_MODEL`).
- Each machine has its own gitignored **`.env`** with its own absolute
  `ELVES_DATA` value.
- Add `.env` to `.gitignore` (keep `.env.example` tracked).

### 3. Syncthing setup (per machine, one-time)

- Install Syncthing on both Macs.
- Add `~/Elves` as a shared folder with the **same Folder ID** on both.
- Pair the two devices (exchange device IDs).
- Syncthing then syncs continuously, peer-to-peer, encrypted in transit, with no
  third party holding the data. Sync happens whenever both machines are online.
- Ship a committed **`.stignore`** (the file Syncthing reads from the synced folder)
  containing `*.tmp`, so Syncthing ignores the transient write-temps
  (`<path>.<pid>.<seq>.tmp`), which are renamed away instantly — chasing them only
  causes churn. The `.bak` / `canvas.backup.json` files intentionally **do** sync as
  extra recovery.
  - Note: `.stignore` lives inside the synced data folder (`~/Elves/.stignore`), so
    the repo will carry a template copy plus a documented step to place it there.

### 4. Conflict model + the one workflow rule

`canvas.json` is a single JSON blob per project, so sync cannot line-merge two
divergent edits.

- **Workflow rule:** work one machine at a time, and let sync settle (a few seconds)
  before switching machines.
- If the same project is ever edited on both machines while offline, Syncthing
  preserves both versions as `.sync-conflict-…` files — nothing is lost; you pick.
- This matches how a single person actually moves between two machines.

### 5. Startup conflict-file warning (in scope)

On server startup, scan the projects tree for `*.sync-conflict-*` files and log a
clear warning if any exist, so a divergence surfaces loudly instead of hiding.

- Small (~20 lines), runs once at boot, never throws (best-effort, like the summary
  backfill).
- Lives alongside the other startup steps in `server/index.ts` / a small helper.
- Purely advisory: it does not modify or resolve anything, just reports paths.

## What we build (summary of changes)

1. `dotenv` dependency + `import 'dotenv/config'` in the server (and MCP) entry.
2. `.env.example` (committed) documenting `ELVES_DATA` and existing env vars.
3. `.gitignore`: add `.env` (keep `.env.example`).
4. `.stignore` template (committed) + README step to place it in the synced folder.
5. Startup conflict-file warning helper wired into server boot.
6. README: a "Syncing across machines" section covering relocate → `.env` →
   Syncthing → the workflow rule.

## Out of scope (future phases)

- **Remote / Tailscale URL.** Reaching the app from a phone or a third machine.
  Recommended future approach: Tailscale (private network, no public exposure, no
  auth) rather than a public obscure URL. Deferred.
- **Live cross-machine lock/heartbeat** to actively prevent simultaneous editing.
  Relying on the workflow rule + conflict-file preservation for now.
- **Per-card file layout** (splitting `canvas.json`) to enable mergeable sync.
- **Real-time cross-machine collaboration.**

## Verification

- Relocate the data root on one machine via `.env`; confirm the app reads/writes the
  new location and that a created project appears under `~/Elves/projects`.
- Run the existing test suite (`npm test`, `npm run e2e`) — the data root is already
  parameterized, so the change surface is small.
- Force a `.sync-conflict-*` file into a project and confirm the startup warning
  fires and names the path.
- Confirm `*.tmp` never lingers in the synced folder (atomic rename + `.stignore`).
