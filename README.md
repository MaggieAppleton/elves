# Elves

A local-first, canvas-based writing studio for taking a piece from scattered notes to a shaped set of your-own-voice points. You think spatially on an infinite canvas of cards; the tool keeps everything on your machine in a plain, human-readable file.

## Features

**The canvas.** An infinite [tldraw](https://tldraw.dev) canvas of **cards** you arrange spatially — a card's horizontal position is its place in the narrative (left = earlier, right = later). Everything autosaves locally, per project, and survives reload.

**Two kinds of card — one hard rule.**
- **Prose cards** — your finished, your-own-voice writing (a point, sentence, or paragraph). **Only you** write these; Claude can never write or edit prose. Shown in your ink.
- **Note cards** — raw material and reference notes (a *source* card's text). These can be **yours** (type them, or import) **or made by Claude** (it transcribes a photo of your handwriting into a note card — still *your* words, digitized). Shown muted with a small **Note** badge.

**Anything Claude writes is orange.** Claude's own wording renders in a warm orange accent so you can always tell it from yours — this covers **comments**, **section headers** it writes or renames, and **summaries**. Your prose, and any notes/sections you wrote, stay in your ink.

**Agent presence — see where Claude is working.** As Claude works the canvas through the MCP, the cards it touches glow a soft orange so you always know where its attention is. **Looking** (when it reads specific cards) is a calm, steady halo that lingers while it's active and fades once it goes idle; **doing** (a comment, merge, move, or a freshly-created card) is a brighter pulse that fades over ~10 seconds, drawing your eye to what just changed. Reading the whole-board map shows nothing (it's a scan, not a focus), and the glow is purely ephemeral — never saved, never in undo.

**Section headers.** Big thematic labels that float above a cluster of cards so the shape of the piece reads at a glance when you zoom out. You or Claude can write and rename them (Claude's show orange).

**Comments.** Claude flags weak spots in your prose — `needs-evidence`, `weak-argument`, `needs-citation`, or a freeform note — each individually resolvable. Always Claude-authored; it comments on your prose, never rewrites it.

**Merge duplicates.** Near-identical note/source cards collapse under one representative (the rest hidden but recoverable) with an "N merged" badge.

**Grouping.** Bind cards that belong together so they **travel as one** when you rearrange the piece — a note and the reference cards that annotate it, or a tight narrative cluster. Uses tldraw's native grouping (select cards → `Cmd+G` / right-click **Group**; `Cmd+Shift+G` to ungroup). Claude can group and ungroup cards too, and `read_map` shows a `groups` list (with each group's members and bounds) plus a `groupId` on every grouped card, so it can see what's bound before it moves anything.

**Images.** Drop in a photo of paper notes or a sketch as an **image card**; ask Claude to **transcribe** it into a note card in your words.

**References.** Papers, articles, books, software, tweets, videos, links — paste a url and the server **unfurls** it into a rich, clickable **reference card** with a type-adaptive face (favicon + hero cached locally so it stays offline). Or ask Claude to enrich a plain-text mention or research a topic onto the canvas. A reference is a *source* card: Claude writes its bibliographic *facts*, never your annotation.

**Summaries & the zoom-out map.** Every note and prose card gets a one-line **summary** generated **locally by [Ollama](https://ollama.com)**. Zoom out past ~70% and each card shows its summary instead of its full text (orange, one uniform readable size, cards grow to fit so nothing is cut off) — so a big piece reads at a glance. No Ollama? Summaries just stay empty and nothing breaks.

**Projects.** Keep several pieces at once, each a self-contained, portable folder; create / switch / rename from the toolbar.

**Claude via MCP.** With the app running, Claude works the canvas through a scoped [MCP](https://modelcontextprotocol.io) server: `list_projects`, `read_map` (a cheap, token-light map with a one-line gist per card, plus the section and group lists) / `read_cards` (full text on demand), `add_comment`, `merge_sources`, `move_cards`, `create_source_card` (transcribe), `create_reference`, the section tools, and `group_cards` / `ungroup_cards`. Every tool targets a specific project, and **none can write your prose**.

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

## Using Claude

With the app running (`npm run dev:all`), Claude reaches the canvas through a scoped
MCP server. In Claude Code, opening this project offers the `elves` MCP server
(see `.mcp.json`); approve it. Then ask Claude things like *"read my canvas and flag
weak spots"*, *"dedupe my source cards"*, *"transcribe this handwritten note"*, or
*"reorder these points for flow"*. Claude's changes appear live and are undoable.

Every canvas tool takes a **required `project` id**: Claude calls `list_projects` to
discover them and confirms which one you mean before acting — it never guesses, and the
server rejects an operation that targets a card outside the named project. There is
deliberately no tool to write or edit your **prose**: Claude comments, dedupes, reorders,
transcribes into *source* cards, and creates *reference* cards, but never writes your
prose. See `skill/elves-canvas.md`.

## Configuration

Set via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVES_DATA` | `data/` (relative to `server/`) | Data root holding `projects/<id>/…` — **all your projects**. |
| `PORT` | `5199` | Port for the canvas server. |
| `VITE_SERVER_URL` | `http://localhost:5199` | Where the web app looks for the server. |
| `ELVES_SUMMARIZER` | `ollama` | Summary backend: `ollama` (local, default) or `off` to disable. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint used for summaries. |
| `OLLAMA_MODEL` | `llama3.2` | Local model for summaries. |

Example — keep a separate set of projects (e.g. for testing):

```bash
ELVES_DATA=./scratch-data npm run server
```

### Card summaries (zoom-out gists)

Every note and prose card gets a one-line, model-authored **summary** — shown on Claude's
`read_map` and, when you **zoom out past ~70%**, in place of the card's full text, so the
shape of a big piece reads at a glance. Summaries render in Claude's orange accent at one
uniform size, and a card grows to fit its summary so nothing is clipped.

Summaries are generated **server-side and locally** via
[Ollama](https://ollama.com): install it and `ollama pull llama3.2`, and the server
summarizes cards as you edit (and backfills existing ones on startup). No Ollama? No
problem — summaries stay empty and the map/zoom fall back to a mechanical first-line
truncation; nothing breaks. Summaries never touch your card text — like section headers
and comments, they're a Claude-authored label *about* a card. Set `ELVES_SUMMARIZER=off`
to disable generation entirely.

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

Your writing stays yours. The data model separates **source** (reference) cards from **prose** (your words), and the codebase enforces — structurally — that only a human, editing in the app, can write a card's prose text. This holds even for automated change-sets: the operations they may contain (comment, merge, move) structurally cannot write a card's text. Claude helps organize and critique, but never writes your prose.

## License

[MIT](./LICENSE) © Maggie Appleton. Shared so others can read, learn from, and tinker with the tool. Your own writing and notes live under `data/` (gitignored) and stay on your machine — they are never part of this repository.
