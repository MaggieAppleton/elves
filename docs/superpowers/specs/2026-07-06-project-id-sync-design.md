# Keep project ids in sync with their display names

**Date:** 2026-07-06
**Status:** Approved

## Problem

An Elves project has two identifiers:

- `id` — an immutable slug (`my-first-essay`), which is also the on-disk folder
  name (`data/projects/<id>/`) and the key in every HTTP URL.
- `name` — a mutable display name shown in the UI.

The `id` is a one-time snapshot: at creation, `slugify(name)` derives it and then
freezes it. `name` stays editable. So the moment you rename a project, the two
drift apart — the "Augment" essay still lives in the folder `my-first-essay/`.
When the user asks an agent to "find the Augment project", the id it must pass
(`my-first-essay`) no longer resembles the name, which is confusing and
error-prone.

`list_projects` already returns both `{id, name}`, so matching is *possible*
today; the pain is that the frozen, drifted id is hard to reason about.

## Decision

**Re-slug the id whenever the display name changes, so the id always tracks the
name.** Chosen over opaque random ids (doesn't improve findability, makes folders
unpleasant to browse) and over a name-lookup-only MCP tool (leaves the "id looks
wrong" discomfort in place).

This is cheap here because **nothing stores the id as a foreign key.** Cards,
sections, and drafts all live inside the project's own `canvas.json` and carry no
project id. The id's only referents are: the directory name, live URLs, and three
per-project `localStorage` keys in the browser. Renaming the folder *is* the whole
migration.

## Design

### 1. `renameProject` re-slugs and moves the folder — `server/projects.ts`

After trimming the new name, compute `desired = slugify(name)`:

- If `desired === id`, it's a name-only rewrite (e.g. "Augment" → "Augment!").
- Otherwise allocate a collision-free id via `uniqueId(dataRoot, desired, id)` —
  the current project's own id is *excluded* so it never counts as a self-clash.
  A genuine clash with a *different* project gets the usual `-2` suffix.
- If the resulting id differs from the old one, `fs.rename()` the project
  directory, then write `project.json` with the new `{ id, name }`.

`fs.rename` on one filesystem is atomic. Return type stays `Project`, but the
returned `id` may now differ from the one passed in — callers must read it back.

### 2. `uniqueId` gains an `exclude` parameter — `server/projects.ts`

`uniqueId(dataRoot, base, exclude?)` drops `exclude` from the "taken" set before
searching. Without this, re-slugging a project whose natural slug is taken by
*itself* (id `report-2`, name "Report", slug `report`) would needlessly bump it to
`report-3`. With `exclude`, it correctly lands on `report` (if free) or stays put.

### 3. One-time startup backfill — `resyncProjectIds` + `server/index.ts`

`resyncProjectIds(dataRoot)` iterates every project; for any whose
`slugify(name) !== id`, it re-slugs through the same collision-safe path (folder
move + `project.json` rewrite) and logs `project id resynced: <old> -> <new>`.
Called in `main()` alongside the existing `migrateLegacyCanvas` /
`migrateSourceCardsToNotes` migrations. Idempotent: a second boot finds every id
already equal to `slugify(name)` and does nothing. This fixes already-drifted
projects (the Augment essay) immediately.

Ordering within the batch is deterministic and clash-safe because `uniqueId`
re-reads the current folder listing on each call and excludes the project being
moved.

### 4. Frontend follows the id through the rename — `src/App.tsx`

`renameFlow` currently assumes the id is stable. New behavior when the returned
`updated.id` differs from the old id:

1. Migrate the two per-project browser keys (`elves:view:<id>`,
   `elves:split:<id>`) from old id → new id, so view/split state survives the
   rename rather than resetting.
2. Flush the live editor store to the *new* id (guards against losing edits still
   inside the 500 ms save debounce; the server already moved `canvas.json` there).
3. Point `elves:lastProject` and `currentProjectId` at the new id. Changing
   `currentProjectId` remounts `<Tldraw key={currentProjectId}>`, which reloads
   the canvas from the moved folder, and — because the realtime handler filters on
   `projectIdRef.current` — silently re-targets live change-sets. No explicit
   resubscribe needed.

A name-only rename (id unchanged) keeps today's behavior: refresh the list, done.

### 5. Untouched by design

- **MCP** — ids stay semantic, so `list_projects` returns matching `{id, name}`
  and the confusion disappears at the source. No new tool (YAGNI).
- **Cards / sections / drafts** — never carried the id; nothing to migrate.

## Edge cases

- **Duplicate names** → `-2` suffix; id and name can still differ by a numeric
  suffix. Unavoidable and rare.
- **Slug unchanged** (punctuation/case-only edit) → cheap name-only write, no move.
- **Rename mid-session** → frontend re-points immediately after the PATCH resolves;
  a stale debounced save to the old id 404s harmlessly (no data written).
- **Backfill self-collision** (`report-2` / "Report") → handled by `exclude` +
  a `newId === proj.id` skip guard.

## Testing

- Unit (`tests/server/projects.test.ts`): rename re-slugs + moves folder; rename
  that only changes punctuation stays put; rename into a taken slug gets a suffix;
  `resyncProjectIds` fixes a drifted project and is idempotent; `resyncProjectIds`
  disambiguates two projects that want the same slug.
- API (`tests/server/api.test.ts`): `PATCH` returns the new id and the old
  id/folder 404s afterward.
- Existing e2e (`e2e/projects.spec.ts`) already renames a project and only asserts
  the switcher label — remains green (renames to a fresh, collision-free name).
