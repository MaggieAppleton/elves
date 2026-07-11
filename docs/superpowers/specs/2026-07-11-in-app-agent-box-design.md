# In-app agent box — design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation

## Problem

Today you drive an agent (Claude Code / Codex / Copilot) from a *terminal*. It reads
and edits your canvas through the scoped `elves` MCP server. There is no way to ask an
agent to do something from *inside the app*.

We want: select cards (or nothing = whole canvas), press `/`, get a small chat box
bottom-middle, type a request ("critique this card", "dedupe all the cards",
"organise these into sections", "what's a better way to phrase this?"), and have an
agent do it — using the same MCP tools it has in the terminal.

## Decisions (locked)

- **Session model:** fresh headless run each time. Every prompt spawns its own CLI
  process, does its thing, and exits. No persistent session, no terminal attach.
- **Agent choice:** one configured default (`ELVES_CLI`, defaults to `claude`). A
  per-message picker can come later.
- **Box output:** full transcript — stream the agent's text and each MCP tool call
  live, plus a final reply. (`claude -p --output-format stream-json` /
  `codex exec --json` emit exactly this.)
- **Tool scope:** canvas + web read — `mcp__elves__* WebSearch WebFetch`. No shell,
  file, or edit access. The elves MCP server already forbids writing prose.

## Why this fits the existing architecture

The `elves` MCP server (`mcp/index.ts`) is stateless glue — a thin HTTP client to the
canvas server on `:5199`. So a freshly-spawned headless agent, pointed at the same
`ELVES_URL`, immediately has full canvas powers *and* inherits the same MCP server
instructions and house rules (one sentence; never write prose) a terminal agent gets.
The only app-specific knowledge we must inject is the **project id** and the
**selection scope** — everything else is already load-bearing in the MCP layer.

Selection already flows browser → server (`POST /selection`, `server/selection.ts`),
and the agent reads it via the `read_selection` MCP tool. Canvas mutations already
stream back to the browser over the realtime WS (`server/realtime.ts`) and render as
the "presence glow". So the transcript and the live canvas update in parallel, from
two channels each doing what it is already good at.

## Architecture

```
[chat box] --POST /agent/run--> [canvas server] --spawn--> [claude -p --stream-json]
     ^                                 |                          |
     |<------- SSE events -------------|<-- stdout stream --------|
     |                                                            v
[canvas glow/cards] <----- existing WS <----- canvas HTTP <-- elves MCP tools
```

New pieces:

1. **`server/agentRun.ts`** — spawns the configured CLI as a headless child,
   restricted to the allowed tools, normalizes its `stream-json` stdout into a small
   set of clean events, and exposes a way to cancel it.
2. **Routes in `server/app.ts`:**
   - `POST /agent/run` → returns an SSE stream of run events. Body: `{ prompt,
     projectId }`. One run at a time (server rejects a second concurrent run, or the
     client disables send while active).
   - `POST /agent/cancel` → kills the running child.
3. **Client chat box** (`src/components/…` + a small hook) — `/`-triggered, renders the
   streamed transcript, has a Cancel button.

### Normalized SSE event shape

The server translates CLI-specific `stream-json` into a stable contract so the client
never parses vendor formats:

```ts
type AgentEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }              // agent's assistant text (streamed)
  | { type: 'tool'; name: string; summary: string } // e.g. name:'read_selection', summary:'2 cards'
  | { type: 'done'; reply: string }             // final assistant message
  | { type: 'error'; message: string }          // spawn failed, CLI missing, non-zero exit
```

`tool.summary` is a friendly one-liner derived from the tool name + args
(`read_selection` → "2 cards", `add_comment` → "card 3", `move_cards` → "4 cards").

### Command shape (Claude default)

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --append-system-prompt "<preamble>" \
  --mcp-config <elves config> \
  --allowedTools "mcp__elves__* WebSearch WebFetch" \
  --disallowedTools "Bash Edit Write MultiEdit NotebookEdit"
```

`ELVES_CLI` selects the adapter (`claude` | `codex` | `copilot`). Each adapter maps
the same normalized concepts (prompt, preamble, mcp config, allowed tools, stream
parsing) onto that CLI's flags. v1 ships the `claude` adapter fully; `codex`/`copilot`
adapters are stubs that map the same shape (fleshed out when tested).

### Prompt preamble (injected server-side)

> You're running inside the Elves app on project `<id>`. The user triggered this from
> the canvas. If cards are selected, call `read_selection` to see them and scope your
> work to those; otherwise call `read_map` for the whole canvas.

We deliberately do **not** re-state the house rules — the elves MCP server injects
those to every connecting agent already.

## UI

- **Trigger:** `/` opens the box, but only when the canvas has focus and you are **not**
  editing a card or any text input (critical — `/` must stay a literal slash while
  writing prose). `Esc` closes.
- **Placement:** floating, bottom-middle, compact.
- **Scope chip:** reads `3 cards selected` or `Whole canvas`, from the current tldraw
  selection.
- **On send:** stream the transcript — tool lines rendered friendly (`read selection
  (2 cards)`, `added comment`, `moved 4 cards`), then the final reply, then a done
  state. **Cancel** kills the run.
- **One run at a time** (v1): send disabled while a run is active; Cancel available.
- **Accent:** the agent's lines render in its accent color (Claude = warm orange),
  consistent with existing presence/comment styling.

## Safety

The headless agent is locked to `mcp__elves__* WebSearch WebFetch`: full canvas powers,
plus read-only web, but no shell, no file access, and (by the MCP server's own rule) no
ability to write your prose. Blast radius = "the canvas, minus your prose" — the same
as a terminal agent today, just triggered from inside the app.

## Vertical slices (each its own PR)

1. **Server run endpoint.** `server/agentRun.ts` (spawn + normalize + cancel), `POST
   /agent/run` (SSE) and `POST /agent/cancel`. Unit-testable with a fake CLI binary; no
   UI. **Riskiest; built and proven first.**
2. **Minimal chat box.** `/` opens it, send → stream → render transcript, cancel.
   Whole-canvas scope only.
3. **Selection scope + friendly transcript.** Scope chip, selection preamble,
   prettified tool-call lines in accent color.
4. **Polish.** `ELVES_CLI` config surfaced, error states (CLI not installed / non-zero
   exit), entry/exit animation with `prefers-reduced-motion`, keyboard niceties.

## Out of scope (later)

- Persistent / multi-turn sessions.
- Per-message agent picker.
- Feeding an already-running terminal session.
- Codex/Copilot adapters fully tested (stubbed in v1).
