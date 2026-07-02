# Elves

A local-first, canvas-based writing studio for taking a piece from scattered notes to a shaped set of your-own-voice points. You think spatially on an infinite canvas of cards; the tool keeps everything on your machine in a plain, human-readable file.

> **Status: Phase 5 (external references).** Create, edit, arrange, and persist cards; keep several **projects** (separate pieces) and switch between them; drop in **images** (photos of paper notes, sketches) as source cards; add **references** (papers, links, tweets, books…) as rich, clickable cards — paste a url to unfurl it, or ask Claude to enrich a mention or research a topic onto the canvas; and work with Claude, who comments / dedupes / reorders and **transcribes handwritten notes** into text source cards — all within a hard boundary (never writing your prose), everything natively undoable. Tana import and MDX are later — see [Roadmap](#roadmap).

## What it does (Phase 1)

- An infinite [tldraw](https://tldraw.dev) canvas with two kinds of **card**:
  - **Prose cards** — your own words (a point, a sentence, a paragraph), shown in your chosen typeface.
  - **Source cards** — raw reference material, shown muted with an origin badge.
- Create cards from a toolbar, drag to arrange, and **double-click to edit** text inline.
- Everything autosaves locally (per project, under `data/projects/<id>/`) and **survives reload**.

## Projects (Phase 4 — multiple pieces)

Elves keeps more than one piece. Each **project** is a self-contained, portable folder
— `data/projects/<id>/` holding its own `canvas.json` and `assets/`.

- The **project switcher** (top-right of the toolbar) lists your projects, and lets you
  **create**, **switch** between, and **rename** them without leaving the canvas.
- The app reopens the project you used last.
- A first run migrates any pre-Phase-4 `data/canvas.json` into a project named
  "My first essay"; a fresh install starts by asking you to create your first project.
- The `id` is a slug of the name, fixed for the life of the project (renaming changes
  only the display name) — it's what Claude passes to target a project.

## What it does (Phase 2a — the Claude-ready canvas)

The canvas receives **change-sets** — the mechanism Claude drives in Phase 2b — applied live and undoably. Phase 2a built and proved this machinery on its own; Phase 2b (below) connects Claude to it:

- **Comments** on any card: color-coded by type (`needs-evidence` · `weak-argument` · `needs-citation`) or freeform, each resolvable (resolve → hidden, kept).
- **Merge** duplicate source cards: they collapse under a representative (hidden, recoverable) with a "N merged" badge.
- **Move / reorder**: cards reposition along the left→right narrative axis (left = earlier, right = later).
- Each change-set applies as **one Ctrl-Z-undoable** step and persists.

A change-set is `POST`ed to the server's `/projects/<id>/changeset` endpoint, applied to that project's canvas on disk immediately (so it persists whether or not the app happens to be open), and also broadcast over a websocket (same port, `5199`, tagged with the project id) so any open app updates live. **The boundary:** Claude's operations never write or edit your **prose** — they comment, merge, move, and (as of Phase 3b) create *source* cards from transcribed handwriting. Your prose stays yours, structurally.

## Using Claude (Phase 2b)

With the app running (`npm run dev:all`), Claude reaches the canvas through a scoped
MCP server. In Claude Code, opening this project offers the `elves` MCP server
(see `.mcp.json`); approve it. Then ask Claude things like "read my canvas and flag
weak spots", "dedupe my source cards", or "reorder these points for flow". Claude's
changes appear live and are undoable.

Claude's tools include `list_projects`, `read_canvas`, `add_comment`,
`merge_sources`, `move_cards`, `create_source_card` (transcribe an image, Phase 3b),
`create_reference` (turn a mention or url into a rich reference card, Phase 5), and the
section tools. Every canvas tool takes a **required `project` id**: Claude calls
`list_projects` to discover them and confirms which one you mean before acting — it never
guesses, and the server rejects an operation that targets a card outside the named
project. There is deliberately no tool to write or edit your **prose**: Claude comments,
dedupes, reorders, transcribes into *source* cards, and creates *reference* cards, but
never writes your prose. See `skill/elves-canvas.md`.

## Images (Phase 3a)

Drag an image onto the canvas — or use the **+ Image** button — to add it as an
**image source card**: a photo of paper notes, a Procreate/iPad sketch, or any
picture that supports a nearby point. Image cards drag and resize like any card.

Images are stored **local-first as files** in the project's `data/projects/<id>/assets/`;
`canvas.json` keeps only a small `assetId`, so each project stays a portable folder no
matter how many sketches you add. Ask Claude to **transcribe** a handwritten-notes image and it types
your handwriting into a text source card next to it (Phase 3b, below).

## External references (Phase 5)

Papers, articles, books, software, tweets/posts, videos, Wikipedia, links — the outside
sources an essay leans on — belong on the canvas as **reference cards**: clickable, with a
**type-adaptive face** (a paper shows authors · year · venue; a blog shows favicon +
title; a tweet shows the handle + post text; a book shows its cover). Every reference card
has an **↗ open** control, and hovering it reveals the full metadata.

- **Paste or drop a link**, or use **+ Link** — the server *unfurls* the url (OpenGraph /
  oEmbed / `citation_*` metadata) into a card and caches its favicon + hero image as local
  files, so the card is rich, clickable, and stays offline-usable.
- **Ask Claude to enrich a mention.** A note that names a source in plain text (*"Andy
  Matuschak: 'A startling glimpse…'"*, or a card listing several papers) becomes proper
  reference cards **beside** the note — the note is left untouched. For papers Claude looks
  up authoritative authors/year/venue/DOI.
- **Ask Claude to research a topic** and drop the relevant references near a card you point
  at, optionally under a section label.

A reference is a **source** card (reference material, never prose), so Claude authoring one
respects the same boundary as transcription — it writes the source's *facts*, never your
words. A reference card's own text stays *your* annotation.

## Requirements

- **Node.js 18+** (developed on Node 23) and **npm**.
- macOS/Linux/Windows. A modern browser for the app.

## Setup

```bash
# from the project root
npm install
```

For the end-to-end tests only, install the Playwright browser once:

```bash
npx playwright install chromium
```

## Running the app

Elves is two local processes: a small **server** that owns the canvas file, and the **web app**. Run both together:

```bash
npm run dev:all
```

Then open **http://localhost:5173**.

- The app runs on `http://localhost:5173` (Vite).
- The canvas server runs on `http://localhost:5199` and reads/writes projects under `data/projects/`.

Prefer separate terminals? Run them independently:

```bash
npm run server   # canvas server on :5199 (watch mode)
npm run dev       # web app on :5173
```

> A small tldraw watermark appears in the corner — that's the free tier and is fine for personal use.

## Using it

- **+ Prose** / **+ Source** in the toolbar add a card at the centre of the view.
- **+ Image** (or drag an image file onto the canvas) adds an image source card.
- **+ Link** (or paste/drop a url) unfurls it into a rich, clickable reference card.
- **Drag** cards to arrange them; use the canvas to group and lay out your argument spatially. Drag a card's corner to **resize** it.
- **Double-click** a card to edit its text; click empty canvas to commit.
- The **project switcher** (top-right) creates / switches / renames projects.
- Edits save automatically (debounced) to the current project's `canvas.json`.

## Configuration

Set via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVES_DATA` | `data/` (relative to `server/`) | Data root holding `projects/<id>/…` — **all your projects**. |
| `PORT` | `5199` | Port for the canvas server. |
| `VITE_SERVER_URL` | `http://localhost:5199` | Where the web app looks for the server. |

Example — keep a separate set of projects (e.g. for testing):

```bash
ELVES_DATA=./scratch-data npm run server
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev:all` | Run the server and web app together (usual dev command). |
| `npm run dev` | Web app only (Vite, `:5173`). |
| `npm run server` | Canvas server only, watch mode (`:5199`). |
| `npm run start` | Canvas server once (no watch). |
| `npm run build` | Production build of the web app. |
| `npm run preview` | Preview the production build. |
| `npm test` | Run the unit test suite (Vitest). |
| `npm run test:watch` | Unit tests in watch mode. |
| `npm run e2e` | Run the Playwright end-to-end tests. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |

## Testing

```bash
npm test           # unit tests (model, store, server, client)
npm run typecheck  # strict TypeScript check
npm run e2e        # end-to-end (needs: npx playwright install chromium)
```

The e2e suite runs its own server against a throwaway `.e2e/data` root, so it won't touch your real projects.

## Project structure

```
src/
  App.tsx                 # tldraw canvas + projects + persistence + realtime + image upload
  main.tsx                # React entry
  theme.css               # --elves-card-font and layout
  components/ProjectSwitcher.tsx # top-right project menu (list / switch / new / rename)
  model/                  # pure data model: cards, comments, change-set ops
  apply/applyChangeSet.ts # applies a change-set as one undoable tldraw step
  client/persistence.ts   # projects API + load/save a project's canvas
  client/realtime.ts      # websocket client receiving {projectId, change-set}
  client/assets.ts        # upload images, build asset URLs (per project)
  client/references.ts    # unfurl a url into a Reference (paste / + Link)
  model/references.ts     # pure reference display helpers + guessRefType (type-adaptive faces)
  shapes/                 # custom tldraw "card" shape (text, image, reference, comments) + CSS
  shapes/ReferenceCardFace.tsx # the type-adaptive reference face + hover metadata
server/
  store.ts                # atomic read/write of a canvas.json
  projects.ts             # project registry: create / list / rename, slug + path guards
  migrate.ts              # one-time legacy canvas -> projects/my-first-essay
  assets.ts               # image files on disk (path-traversal-safe)
  unfurl.ts               # fetch a url -> structured Reference (OG / oEmbed / citation_*)
  app.ts                  # Express: /projects[/:id/{canvas,cards,changeset,assets,unfurl}]
  realtime.ts             # websocket broadcast of change-sets (tagged by project)
  index.ts                # server entrypoint (http + ws + express)
mcp/                      # scoped MCP server — Claude's tools (project-targeted)
skill/                    # the Claude skill (how to work the canvas)
tests/                    # Vitest unit tests
e2e/                      # Playwright end-to-end tests
data/projects/<id>/       # each project's canvas.json + assets/ (git-ignored)
```

## Data & privacy

Local-first by design. Each project is a plain, human-readable folder (`data/projects/<id>/canvas.json` plus an `assets/` folder of image files), all on your machine and git-ignored. **Your canvas is never sent anywhere.**

The one thing that reaches outside your machine is **reference unfurling**: when you paste
a link (or ask Claude to enrich/research references), the server fetches *that public URL*
to read its metadata and cache its favicon/image. This is always an **explicit,
per-action** fetch of a page you named — never a background upload of your work. If you
never add a reference, nothing leaves your machine.

## Design principle

Your writing stays yours. The data model separates **source** (reference) cards from **prose** (your words), and the codebase enforces — structurally — that only a human, editing in the app, can write a card's prose text. As of Phase 2a this holds even for automated change-sets: the operations they may contain (comment, merge, move) structurally cannot write a card's text. Claude helps organize and critique, but never writes your prose.

## Roadmap

- **Phase 2a — Claude-ready canvas (done):** change-sets for comments, merge, and reorder, applied live and undoably.
- **Phase 2b — Claude connected (done):** a scoped MCP server exposing the change-set operations + a Claude skill, so Claude reads the canvas and comments / dedupes / reorders within the boundary.
- **Phase 3a — images on the canvas (done):** drag-in / **+ Image** source cards, stored as local files.
- **Phase 3b — transcription (done):** Claude reads a handwritten-notes image and transcribes it into a text source card (your words), via a `create_source_card` tool — still never writing your prose.
- **Phase 4 — multiple projects (done):** self-contained project folders with an in-app switcher (create / switch / rename) and a required `project` target on every Claude tool (+ `list_projects`), so Claude always knows which piece it's working in.
- **Phase 5 — external references (done):** first-class **reference cards** with a type-adaptive face (paper / article / social / book / software / …), click-to-open + hover metadata; a server *unfurl* endpoint (paste/drop a url → rich card, favicon + hero cached locally); and a `create_reference` Claude tool for enriching plain-text mentions and researching a topic onto the canvas — all as *source* cards, never prose.
- **Later:** the citation loop (a `needs-citation` comment → attach a reference), reference→claim links, references surviving Tana import / MDX export, multi-device.

See the design specs and build plans for the full rationale: [`2026-07-01-elves-design.md`](./2026-07-01-elves-design.md) (overall) · [`2026-07-01-elves-mvp-phase1-plan.md`](./2026-07-01-elves-mvp-phase1-plan.md) (Phase 1) · [`2026-07-01-elves-phase2-design.md`](./2026-07-01-elves-phase2-design.md) + [`2026-07-01-elves-phase2a-plan.md`](./2026-07-01-elves-phase2a-plan.md) (Phase 2) · [`2026-07-01-elves-phase3-design.md`](./2026-07-01-elves-phase3-design.md) + [`2026-07-01-elves-phase3a-plan.md`](./2026-07-01-elves-phase3a-plan.md) (Phase 3).
