# Multi-project support for Elves — design

**Date:** 2026-07-02
**Status:** Approved, ready for implementation
**Branch:** `feature/multi-project`

## Problem

Elves is hardwired to a single canvas. The browser, the Express server, and Claude
(via MCP) all converge on one file — `data/canvas.json` (plus `data/assets/`). There
is no way to keep more than one essay, no UI to see or switch between essays, and no
way for Claude to know *which* essay it is editing. To work on two essays today you
would have to run two servers on two ports and re-point the MCP `ELVES_URL` — manual
and brittle.

We want first-class projects: create, list, switch, and rename them; and a required,
explicit project target on every MCP tool so Claude always knows (and asks when it
does not) which essay it is working in.

## Decisions (from brainstorming)

1. **MCP targeting:** a **required `project` parameter on every tool**, plus a
   `list_projects` discovery tool, plus server-side project/cardId cross-checking.
   Stateless targeting is the most reliable against context summarization, MCP
   reconnects, and long-horizon drift; a required field structurally enforces the
   "ask if unknown" behavior (Claude cannot fabricate an id it was never given).
2. **UI:** an **in-canvas toolbar switcher** — a dropdown in the existing toolbar to
   see, create, switch, and rename projects without leaving the canvas.
3. **v1 scope:** **create, list, switch, rename.** No delete in v1 (YAGNI).

## Architecture: one server, project-scoped routing

Keep the single Express server and single MCP process. Make every data operation
project-scoped by an `id`. The server holds a `dataRoot` (`data/`) instead of a single
canvas path and derives per-project paths on each request. Switching projects means
"talk to a different `id`" — no restarts, no new processes.

Rejected alternative: one server process per project (spawn a server per essay). It
reuses today's single-canvas server untouched but makes "switch project" mean
"spawn/kill processes and re-point connections," which fights the in-canvas switcher
and stateless-MCP decisions.

The existing storage primitives (`readCanvas(path)`, `writeCanvas(path, data)`,
`assetsDir(canvasPath)`) are already path-parameterized, so this is a wiring/routing
change, not a storage rewrite. The change-set model, undo/redo, the prose boundary,
image cards, and transcription are unchanged — they simply operate inside a project.

## Data layout — a project is a self-describing folder

```
data/
  projects/
    climate-essay/
      project.json      # { id, name, createdAt }
      canvas.json       # the tldraw snapshot (today's format, unchanged)
      assets/           # images for THIS project
    memoir-intro/
      project.json
      canvas.json
      assets/
```

- **`id`** = the folder name: a slug derived from the display name at creation
  (`"Climate essay"` -> `climate-essay`), made unique with a `-2`, `-3`, ... suffix if
  taken, and filesystem-safe (reuse the path-traversal guard already in
  `server/assets.ts`). The `id` is what Claude passes and never changes.
- **`name`** = the human display label, editable. Rename touches only `name`; the
  folder/id stays put, so nothing breaks mid-session.
- The project list is **derived by scanning `data/projects/`** and reading each
  `project.json`. No central manifest to keep in sync; each folder is portable and
  self-contained, matching the "portable folder" ethos.

## Server API — project-scoped endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/projects` | list `[{id, name, createdAt}]`, sorted by `createdAt` |
| `POST` | `/projects` `{name}` | create -> `{id, name, createdAt}` |
| `PATCH`| `/projects/:id` `{name}` | rename (updates `project.json.name`) |
| `GET`  | `/projects/:id/canvas` | load snapshot |
| `POST` | `/projects/:id/canvas` | save snapshot |
| `GET`  | `/projects/:id/cards` | card digest (for MCP) |
| `POST` | `/projects/:id/changeset` | validate + cross-check + broadcast (tagged with `:id`) |
| `POST` | `/projects/:id/assets` | upload image |
| `GET`  | `/projects/:id/assets/:assetId` | serve image |

- Unknown `:id` on any scoped route -> `404 {error: 'unknown project'}`.
- `POST /projects` validates a non-empty `name`; slugifies to an `id`; ensures
  uniqueness; creates the folder, an empty `canvas.json` (`EMPTY_CANVAS`), an `assets/`
  dir, and `project.json`.
- `PATCH /projects/:id` validates a non-empty `name`, updates `project.json.name`. The
  `id` is immutable.
- `POST /projects/:id/changeset` keeps today's checks (`isChangeSet`,
  `changeSetWritesText` -> `403`) and adds a **cross-check**: every `cardId` an
  operation references as an *existing* card (comment target, merge members, move
  targets) must exist in that project's current cards (reuse the digest); a mismatch
  -> `409 {error: 'card not in project'}`. Operations that mint a new card
  (`create_source_card`) reference no existing id and are exempt. This makes a
  mistargeted Claude operation fail loudly instead of silently no-op'ing.

## Real-time — tag broadcasts by project

The WebSocket broadcast payload changes from `changeSet` to `{ projectId, changeSet }`.
`broadcast(projectId, changeSet)` is called by the scoped `/changeset` handler. The
client applies an incoming change-set **only if `projectId` matches the project it
currently has open**, so a change to one essay never lands in another essay open in a
second tab.

## MCP contract — explicit targeting

- All five existing tools (`read_canvas`, `add_comment`, `merge_sources`,
  `move_cards`, `create_source_card`) gain a **required `project` string** and call
  `/projects/:project/...`.
- New **`list_projects`** tool returns `[{id, name}]` so Claude can map "the climate
  essay" -> `climate-essay`, confirm, and ask the user when it cannot tell.
- Tool descriptions state the rule: *if you do not already know the project id, call
  `list_projects` first and confirm with the user; never guess.*
- The prose-write boundary (`changeSetWritesText` -> `403`) is unchanged and still
  applies per project.

## Client / UI — the toolbar switcher

- **On load:** fetch `/projects`; open the last-used project (from `localStorage`
  key `elves:lastProject`), else the first project. If there are zero projects, show a
  "Create your first project" prompt.
- **Switcher** (dropdown in the existing toolbar): lists projects with a check on the
  current one; `+ New project...` (prompt for a name -> `POST` -> switch to it);
  `Rename current project...` (prompt -> `PATCH`).
- **Switching** flushes the pending autosave, then loads the target's snapshot into the
  tldraw store; persists the choice to `localStorage`; autosave and asset upload/fetch
  target `/projects/:current/...`.
- The currently-open project id is the client's source of truth for filtering
  real-time broadcasts.

## Migration — no data loss

On startup, if `data/projects/` does not exist but a legacy `data/canvas.json` does:
create `data/projects/my-first-essay/`, move `canvas.json` and `assets/` into it, and
write its `project.json` (name: "My first essay" — renameable immediately since rename
ships in v1). Fresh installs start with zero projects and the create-first-project
prompt. Migration runs once and is idempotent (a present `data/projects/` short-circuits
it).

## Preserved invariants

- Prose-write boundary intact (`changeSetWritesText` -> `403`), now per project.
- Change-set application and undo/redo unchanged.
- Image cards, asset storage as local files, and transcription unchanged.
- This work is additive; the on-disk `canvas.json` format is unchanged.

## Testing

- **Unit** — registry (slugify, uniqueness suffixing, path-traversal guard, rename
  keeps id stable, migration idempotency); project-scoped path derivation; scoped store.
- **Server API** — scoped routes (list/create/rename/canvas/cards/changeset/assets),
  unknown-project 404, changeset cross-check 409, prose-boundary 403 still enforced.
- **MCP** — every tool requires `project`; `list_projects` returns the registry;
  targeting hits the right project; elvesClient builds scoped URLs.
- **Client** — persistence targets scoped URLs; project list/create/rename helpers;
  real-time filter ignores other projects' broadcasts.
- **E2E** — create -> switch -> rename; Claude tools operate on the named project;
  migration path from a legacy `data/canvas.json`.
- Existing tests are updated to the scoped routes.

## Implementation phases

0. Design doc + branch (this document).
1. Project registry + path derivation + migration, with unit tests.
2. Project-scoped server API + real-time tagging + cross-check, with tests.
3. MCP tools (required `project`, `list_projects`) + elvesClient, with tests.
4. Client persistence / assets / real-time scoping, with tests.
5. UI toolbar switcher (list / switch / create / rename).
6. E2E tests; full suite + typecheck green.

Each phase is committed when its tests pass.
