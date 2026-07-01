# Elves

A local-first, canvas-based writing studio for taking a piece from scattered notes to a shaped set of your-own-voice points. You think spatially on an infinite canvas of cards; the tool keeps everything on your machine in a plain, human-readable file.

> **Status: Phase 2a (Claude-ready canvas).** Create, edit, arrange, and persist cards, and apply Claude-style *change-sets* — comments, source-merges, and reorders — all natively undoable. Claude itself connects in Phase 2b; images and Tana/MDX bridges are later — see [Roadmap](#roadmap).

## What it does (Phase 1)

- An infinite [tldraw](https://tldraw.dev) canvas with two kinds of **card**:
  - **Prose cards** — your own words (a point, a sentence, a paragraph), shown in your chosen typeface.
  - **Source cards** — raw reference material, shown muted with an origin badge.
- Create cards from a toolbar, drag to arrange, and **double-click to edit** text inline.
- Everything autosaves to a local `data/canvas.json` and **survives reload**.

## What it does (Phase 2a — the Claude-ready canvas)

The canvas can now receive **change-sets** — the exact mechanism Claude will drive in Phase 2b — applied live and undoably, with no Claude yet:

- **Comments** on any card: color-coded by type (`needs-evidence` · `weak-argument` · `needs-citation`) or freeform, each resolvable (resolve → hidden, kept).
- **Merge** duplicate source cards: they collapse under a representative (hidden, recoverable) with a "N merged" badge.
- **Move / reorder**: cards reposition along the left→right narrative axis (left = earlier, right = later).
- Each change-set applies as **one Ctrl-Z-undoable** step and persists.

A change-set is `POST`ed to the server's `/changeset` endpoint and broadcast over a websocket (same port, `5199`) to the open app. **The boundary:** a change-set's operations are exactly *comment*, *merge*, and *move* — **none can write a card's text.** Your prose stays yours, structurally.

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
- The canvas server runs on `http://localhost:5199` and reads/writes `data/canvas.json`.

Prefer separate terminals? Run them independently:

```bash
npm run server   # canvas server on :5199 (watch mode)
npm run dev       # web app on :5173
```

> A small tldraw watermark appears in the corner — that's the free tier and is fine for personal use.

## Using it

- **+ Prose** / **+ Source** in the toolbar add a card at the centre of the view.
- **Drag** cards to arrange them; use the canvas to group and lay out your argument spatially.
- **Double-click** a card to edit its text; click empty canvas to commit.
- Edits save automatically (debounced) to `data/canvas.json`.

## Configuration

Set via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVES_CANVAS` | `data/canvas.json` (relative to `server/`) | Path to the canvas file — **one file per piece**. |
| `PORT` | `5199` | Port for the canvas server. |
| `VITE_SERVER_URL` | `http://localhost:5199` | Where the web app looks for the server. |

Example — work on a different piece:

```bash
ELVES_CANVAS=./pieces/my-essay.json npm run server
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

The e2e suite runs its own server against a throwaway `.e2e/canvas.json`, so it won't touch your real canvas.

## Project structure

```
src/
  App.tsx                 # mounts the tldraw canvas + wires persistence + realtime
  main.tsx                # React entry
  theme.css               # --elves-card-font and layout
  model/                  # pure data model: cards, comments, change-set ops
  apply/applyChangeSet.ts # applies a change-set as one undoable tldraw step
  client/persistence.ts   # load/save the canvas via the server
  client/realtime.ts      # websocket client receiving change-sets
  shapes/                 # the custom tldraw "card" shape (comments, merged) + CSS
server/
  store.ts                # atomic read/write of canvas.json
  app.ts                  # Express app: GET/POST /canvas, POST /changeset
  realtime.ts             # websocket broadcast of change-sets
  index.ts                # server entrypoint (http + ws + express)
tests/                    # Vitest unit tests
e2e/                      # Playwright end-to-end tests
data/                     # your canvas.json lives here (git-ignored)
```

## Data & privacy

Local-first by design. Your canvas is a plain, human-readable JSON file on your machine (`data/canvas.json`), which is git-ignored. Nothing is sent anywhere.

## Design principle

Your writing stays yours. The data model separates **source** (reference) cards from **prose** (your words), and the codebase enforces — structurally — that only a human, editing in the app, can write a card's prose text. As of Phase 2a this holds even for automated change-sets: the operations they may contain (comment, merge, move) structurally cannot write a card's text. Claude helps organize and critique, but never writes your prose.

## Roadmap

- **Phase 2a — Claude-ready canvas (done):** change-sets for comments, merge, and reorder, applied live and undoably.
- **Phase 2b — Claude connected (next):** a scoped MCP server exposing the change-set operations + a Claude skill, so Claude reads the canvas and comments / dedupes / reorders within the boundary.
- **Phase 3 — Images + vision:** drag-in image source cards; derive source cards from a photo or sketch.
- **Later:** assisted Tana import, MDX export, multi-device.

See the design specs and build plans for the full rationale: [`2026-07-01-elves-design.md`](./2026-07-01-elves-design.md) (overall) · [`2026-07-01-elves-mvp-phase1-plan.md`](./2026-07-01-elves-mvp-phase1-plan.md) (Phase 1) · [`2026-07-01-elves-phase2-design.md`](./2026-07-01-elves-phase2-design.md) + [`2026-07-01-elves-phase2a-plan.md`](./2026-07-01-elves-phase2a-plan.md) (Phase 2).
