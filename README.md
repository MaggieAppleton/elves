# Elves

A local-first, canvas-based writing studio for taking a piece from scattered notes to a shaped set of your-own-voice points. You think spatially on an infinite canvas of cards; the tool keeps everything on your machine in local files you own.

It's a writing app where **agents collaborate with you but never write for you.** An agent — Claude, Codex, GitHub Copilot, or any other tool that speaks [MCP](https://modelcontextprotocol.io) — reads your canvas, flags weak spots, dedupes notes, reorders points, and asks pointed questions. But the prose stays yours: the data model makes it structurally impossible for an agent to write or edit a word of it.

## Features

**The canvas.** An infinite [tldraw](https://tldraw.dev) canvas of **cards** you arrange spatially — a card's horizontal position is its place in the narrative (left = earlier, right = later). Everything autosaves locally, per project, and survives reload.

**Kinds of card — one hard rule.** Everything on the canvas is a card, but only one kind holds your writing, and **only you** may write it.
- **Prose cards** — your finished, your-own-voice writing (a point, sentence, or paragraph). **Only you** write these; an agent can never write or edit prose. Shown in your ink.
- **Note cards** — raw material and reference notes (a *source* card's text). These can be **yours** (type them, or import) **or made by an agent** (it transcribes a photo of your handwriting into a note card — still *your* words, digitized). Shown muted with a small **Note** badge.
- **Figure cards** — a placeholder for a planned *visual* — an illustration, diagram, or interactive animation — sitting at its narrative position among the prose. Each carries a working **title**, a description of what the visual needs to show, and a **status chip** you click to cycle `idea → sketched → final`, rendered inside a dashed sketch-frame that reads as "a visual goes here." You add them from the toolbar, or an agent proposes them; a figure is a *plan*, never your prose, so an agent may write and edit its title/description.
- **Question cards** — an editor's sticky note. An agent drops a short, pointed **question** beside the cluster it's about; you answer by writing your *own* cards next to it, then **dismiss** it. Always agent-authored, never draft prose — so they stay on the safe side of the rule. A dismissed question is hidden but kept in-file (recoverable, and so agents won't re-ask).

**Agent writing is marked in its accent.** Anything an agent writes renders in its own accent color — Claude's, for example, is a warm orange — so you can always tell it from yours. This covers **comments**, **section headers** it writes or renames, **figures** it proposes, **questions** it asks, and **summaries**. Your prose, and any notes/sections you wrote, stay in your ink.

**Agent presence — see where an agent is working.** As an agent works the canvas through the MCP, the cards it touches glow in its accent so you always know where its attention is. **Looking** (when it reads specific cards) is a calm, steady halo that lingers while it's active and fades once it goes idle; **doing** (a comment, merge, move, or a freshly-created card) is a brighter pulse that fades over ~10 seconds, drawing your eye to what just changed. Reading the whole-board map shows nothing (it's a scan, not a focus), and the glow is purely ephemeral — never saved, never in undo.

**Section headers.** Big thematic labels that float above a cluster of cards so the shape of the piece reads at a glance when you zoom out. You or an agent can write and rename them (an agent's show in its accent).

**Comments.** An agent flags weak spots in your prose — `needs-evidence`, `weak-argument`, `needs-citation`, `wants-figure`, `counterpoint`, `tighten`, `unclear`, `structure`, or a freeform note — each individually resolvable. Always agent-authored; it comments on your prose, never rewrites it.

**Review passes.** Summon one of five reviewer personalities — Devil's Advocate, The Fact-Checker, The Trimmer, The First Reader, The Architect — for a bounded, in-character editorial pass: each reads for one thing only, works within a comment/question budget, and ends with a short verdict. Click **Review** in the topbar to summon one (with an optional focus note) and watch the pass move from pending to claimed to verdict, or ask your agent in chat ("play devil's advocate on my draft") and its MCP prompt does the same thing without the app. Either way, an agent picks up the pass and annotates the canvas — the app itself never runs a review.

**Merge duplicates.** Near-identical note cards collapse under one representative (the rest hidden but recoverable) with an "N merged" badge.

**Grouping.** Bind cards that belong together so they **travel as one** when you rearrange the piece — a note and the reference cards that annotate it, or a tight narrative cluster. Uses tldraw's native grouping (select cards → `Cmd+G` / right-click **Group**; `Cmd+Shift+G` to ungroup). Agents can group and ungroup cards too, and `read_map` shows a `groups` list (with each group's members and bounds) plus a `groupId` on every grouped card, so it can see what's bound before it moves anything.

**Images.** Drop in a photo of paper notes or a sketch as an **image card**; ask an agent to **transcribe** it into a note card in your words.

**References.** Papers, articles, books, software, tweets, videos, links — paste a url and the server **unfurls** it into a rich, clickable **reference card** with a type-adaptive face (favicon + hero cached locally so it stays offline). Or ask an agent to enrich a plain-text mention or research a topic onto the canvas. A reference is a *source* card: an agent writes its bibliographic *facts*, never your annotation.

**Summaries & the zoom-out map.** Every note and prose card gets a one-line **summary** generated **locally by [Ollama](https://ollama.com)**. Zoom out past ~70% and each card shows its summary instead of its full text (orange, one uniform readable size, cards grow to fit so nothing is cut off) — so a big piece reads at a glance. No Ollama? Summaries just stay empty and nothing breaks.

**Linear draft — read the canvas as a piece.** A **draft drawer** slides in from the right edge — pull it out with the **«** tab, or cycle **Canvas · Split · Draft** with `⌘/Ctrl + \` (add `⇧` to walk back) — compiling your prose cards into one continuous reading pane, in true narrative order: **sections** run left → right as the order of the piece, and **within a section** cards run top → bottom. Click any paragraph to jump to its card on the canvas; **Copy as Markdown** exports the whole thing with `##` headings. Only prose compiles (notes, figures, and questions stay off the page), and you can opt any card out of the draft so an aside doesn't read as part of the piece. It's read-only — the canvas stays the one place prose is written — and an agent reads the very same compile through `read_draft`.

**Projects.** Keep several pieces at once, each a self-contained, portable folder; create / switch / rename from the toolbar.

**Agents via MCP.** With the app running, an agent works the canvas through a scoped [MCP](https://modelcontextprotocol.io) server — Claude, Codex, GitHub Copilot, or any other MCP-capable tool. It **reads** with `list_projects`, `read_map` (a cheap, token-light map with a one-line gist per card, plus the section and group lists), `read_cards` (full text on demand), and `read_draft` (the piece as one linear draft). It **organizes and critiques** with `add_comment`, `merge_notes`, `move_cards`, `create_note_card` (transcribe), `create_reference`, `create_figure_card`, `create_question`, `create_section` / `edit_section_text` / `move_sections`, and `group_cards` / `ungroup_cards`. It runs **review passes** with `list_reviews`, `start_review`, `complete_review` — bounded, in-character editorial reads it discovers pending or opens ad-hoc. It can `edit_card` (a note's body, a reference's annotation, or a figure's title/description) and `delete_card` — but only for working-material cards it authored. Every tool targets a specific project, and **none can write your prose**.

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

- **+ Prose** / **+ Notes** in the toolbar add a card at the centre of the view.
- **+ Image** (or drag an image file onto the canvas) adds an image note card.
- **+ Link** (or paste/drop a url) unfurls it into a rich, clickable reference card.
- **+ Figure** adds a figure card — a placeholder for a planned visual; click its **status chip** to cycle `idea → sketched → final`.
- **Drag** cards to arrange them; use the canvas to group and lay out your argument spatially. Drag a card's corner to **resize** it.
- **Double-click** a card to edit its text; click empty canvas to commit.
- The **draft drawer** slides in from the right — pull the **«** tab, or cycle **Canvas · Split · Draft** with `⌘/Ctrl + \` (add `⇧` to walk back).
- The **project switcher** (top-right) creates / switches / renames projects.
- Edits save automatically (debounced) to the current project's `canvas.json`.

## Using an agent

With the app running (`npm run dev:all`), an agent reaches the canvas through a scoped
MCP server. Point any MCP-capable agent — Claude Code, Codex, GitHub Copilot, or another —
at the `elves` server (see `.mcp.json`); in Claude Code, opening this project offers it,
so approve it. Then ask the agent things like *"read my canvas and flag weak spots"*,
*"dedupe my note cards"*, *"transcribe this handwritten note"*, *"reorder these points for
flow"*, *"read my draft top-to-bottom and tell me where it sags"*, *"suggest where a
diagram would help"*, *"ask me questions about the gaps"*, or *"play devil's advocate on
my draft"* to summon a review pass. Its changes appear live and are undoable. A review you
summon from the app's **Review** button starts out pending — the next agent you talk to
picks it up via `list_reviews`, so it's fine to summon one before you've opened a chat.

Each agent authors under its own id — set `ELVES_AGENT` when launching the MCP server
(e.g. `ELVES_AGENT=codex`) so its cards carry its own authorship mark; it defaults to
`claude`. See "Configuration".

Every canvas tool takes a **required `project` id**: the agent calls `list_projects` to
discover them and confirms which one you mean before acting — it never guesses, and the
server rejects an operation that targets a card outside the named project. There is
deliberately no tool to write or edit your **prose**: an agent comments, dedupes, reorders,
transcribes into *note* cards, creates *reference* and *figure* cards, and asks *questions*
— but never writes your prose. See `skill/elves-canvas.md`.

## Configuration

Set via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVES_DATA` | `data/` (relative to `server/`) | Data root holding `projects/<id>/…` — **all your projects**. |
| `PORT` | `5199` | Port for the canvas server. |
| `VITE_SERVER_URL` | `http://localhost:5199` | Where the web app looks for the server. |
| `ELVES_AGENT` | `claude` | Authorship id the MCP server stamps on cards it creates — set it per agent (e.g. `codex`) so each agent's writing carries its own mark. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint used for summaries. |
| `OLLAMA_MODEL` | `llama3.2` | Local model used for summaries. |

Example — keep a separate set of projects (e.g. for testing):

```bash
ELVES_DATA=./scratch-data npm run server
```

### Card summaries (zoom-out gists)

Every note and prose card gets a one-line, model-authored **summary** — shown on the agent's
`read_map` and, when you **zoom out past ~70%**, in place of the card's full text, so the
shape of a big piece reads at a glance. Summaries render in the agent's accent color at one
uniform size, and a card grows to fit its summary so nothing is clipped.

Summaries are generated **server-side and locally** via
[Ollama](https://ollama.com): install it and `ollama pull llama3.2`, and the server
summarizes cards as you edit (and backfills existing ones on startup). No Ollama? No
problem — summaries stay empty and the map/zoom fall back to a mechanical first-line
truncation; nothing breaks. Summaries never touch your card text — like section headers
and comments, they're an agent-authored label *about* a card. Point `OLLAMA_HOST` /
`OLLAMA_MODEL` at a different endpoint or model if you'd rather not use the defaults.

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
  App.tsx                 # tldraw canvas + projects + persistence + realtime + image upload + view toggle
  main.tsx                # React entry
  meta.ts                 # shared build/version metadata
  theme.css               # --elves-card-font and layout
  components/ProjectSwitcher.tsx # top-right project menu (list / switch / new / rename)
  components/DraftDrawerControls.tsx # draft-drawer chevrons: Canvas · Split · Draft (⌘/Ctrl + \)
  components/DraftPane.tsx       # the linear draft: canvas compiled into a piece, read-only
  model/                  # pure data model: cards, comments, sections, change-set ops
  model/draft.ts          # compile the canvas into narrative reading order (shared by pane + server + MCP)
  model/figures.ts        # figure-card status cycle (idea → sketched → final)
  model/questions.ts      # question-card model (agent-authored, dismissable)
  model/references.ts     # pure reference display helpers + guessRefType (type-adaptive faces)
  model/presence.ts       # agent presence (where an agent is looking / working)
  apply/applyChangeSet.ts # applies a change-set as one undoable tldraw step
  client/persistence.ts   # projects API + load/save a project's canvas
  client/realtime.ts      # websocket client receiving {projectId, change-set}
  client/assets.ts        # upload images, build asset URLs (per project)
  client/references.ts    # unfurl a url into a Reference (paste / + Link)
  client/presence.ts      # receive + fade agent presence pulses
  shapes/                 # custom tldraw shapes: "card" (text/image/reference/figure), "section", "question"
  shapes/ReferenceCardFace.tsx # the type-adaptive reference face + hover metadata
  shapes/agents.tsx       # agent registry → accent + logomark (e.g. Claude's orange)
server/
  store.ts                # atomic read/write of a canvas.json
  digest.ts               # the token-light card map + per-card digests (read_map / read_cards)
  projects.ts             # project registry: create / list / rename, slug + path guards
  migrate.ts              # one-time legacy canvas -> projects/my-first-essay
  migrateNotes.ts         # one-time "source" -> "note" card migration
  assets.ts               # image files on disk (path-traversal-safe)
  unfurl.ts               # fetch a url -> structured Reference (OG / oEmbed / citation_*)
  summarize/              # local Ollama summaries (one-line gists, backfilled on startup)
  app.ts                  # Express: /projects[/:id/{canvas,cards,draft,changeset,assets,unfurl}]
  realtime.ts             # websocket broadcast of change-sets (tagged by project)
  index.ts                # server entrypoint (http + ws + express)
mcp/                      # scoped MCP server — the agent's tools (project-targeted)
skill/                    # the agent skill (how to work the canvas)
tests/                    # Vitest unit tests
e2e/                      # Playwright end-to-end tests
data/projects/<id>/       # each project's canvas.json + assets/ (git-ignored)
```

## Data & privacy

Local-first by design. Each project is a self-contained local folder (`data/projects/<id>/canvas.json` — a raw tldraw record dump that also carries the session's camera and selection — plus an `assets/` folder of image files), all on your machine and git-ignored. **Your canvas is never sent anywhere.**

The one thing that reaches outside your machine is **reference unfurling**: when you paste
a link (or ask an agent to enrich/research references), the server fetches *that public URL*
to read its metadata and cache its favicon/image. This is always an **explicit,
per-action** fetch of a page you named — never a background upload of your work. If you
never add a reference, nothing leaves your machine.

## Design principle

Your writing stays yours. The data model separates **source** (reference) cards from **prose** (your words), and the codebase enforces — structurally — that only a human, editing in the app, can write a card's prose text. This holds even for automated change-sets: the operations they may contain (comment, merge, move) structurally cannot write a card's text. Agents help organize and critique, but never write your prose.

## License

[MIT](./LICENSE) © Maggie Appleton. Shared so others can read, learn from, and tinker with the tool. Your own writing and notes live under `data/` (gitignored) and stay on your machine — they are never part of this repository.
