# Agent Presence Glow — Design Spec

**Date:** 2026-07-03
**Status:** Approved (brainstorming → implementation)
**Author:** Maggie + Claude

## Goal

Give the user a sense of **where the agent is looking and working on the canvas**, in real time, while they work alongside it. When the agent (Claude, via MCP) reads specific cards or acts on them, those cards get a **soft orange glow** — orange being "the colour of the agent" (it already owns `--elves-claude-accent` for Claude-authored content).

This is a **presence / awareness** feature, not a document feature. It communicates attention and recent activity; it never changes the piece.

## Behaviour (agreed)

Two visually distinct signals, same orange family, distinguished by intensity and motion:

| Signal | Trigger | Look | Lifetime |
|--------|---------|------|----------|
| **Looking** | `read_cards` on specific card ids | Soft, calm, **steady** orange halo | Persists on the last-read cards; **fades on idle** (~25s with no new MCP activity). New reads refresh/move it. |
| **Doing** | A change-set lands (`add_comment`, `merge_notes`, `move_cards`, `create_note_card`, `create_reference`, section ops, `group`/`ungroup`) | **Brighter orange pulse** at the moment of action that settles, then fades | Fades fully over **~10s** (created cards included — draws the eye to new arrivals, then gone). |

**`read_map` shows nothing.** It returns the whole board in one call (every card's gist + all sections + groups); it is a top-level scan, not attention on specific cards. Glowing everything would be noise. Only `read_cards` (which takes explicit card ids) signals "looking".

**`set_summary` shows nothing.** Summaries are background reconciliation on a debounce, not the agent working; their change-sets are excluded from the "doing" glow.

## Core architectural principle

Presence is **ephemeral** and must be **quarantined from the document**:

- Never written to `canvas.json`.
- Never in tldraw's undo/redo history.
- Never in the tldraw document store at all.

It lives only in a client-side reactive store (a signia `atom`) plus lightweight, fire-and-forget WebSocket messages. If every browser tab closed, presence would simply be gone — as it should be.

## Why "Approach 1" (derive-from-change-sets + one read signal, client-timed)

The existing system has an asymmetry:

- **Write tools already broadcast everything the glow needs.** Every change-set that reaches the canvas is applied by `src/apply/applyChangeSet.ts`, which knows exactly which shape ids it touched — **including the ids of cards it just created** (the client mints them locally with `createShapeId()`; the server never sees them). So the "doing" glow needs **no new server work** — just capture the affected ids at apply time.
- **Read tools broadcast nothing today.** `read_cards` → `POST /projects/:id/cards` is pure request/response. This is the *only* gap: emit a small presence message from that route.

All *timing* (idle fade, 10s decay, pulse) lives on the client, next to the CSS, so it stays stateless on the server and tunable by eye.

## Components

### 1. `src/client/presence.ts` (new) — the ephemeral presence store

A signia `atom` (imported from `tldraw`) holding `Map<TLShapeId, PresenceEntry>`:

```ts
type PresenceMode = 'looking' | 'doing'
interface PresenceEntry { mode: PresenceMode; expiresAt: number }
```

Public API:

- `markLooking(ids: TLShapeId[])` — set/refresh each id to `{ mode: 'looking', expiresAt: now + LOOKING_TTL_MS }`. A `doing` entry is not downgraded to `looking` while still fresh.
- `markDoing(ids: TLShapeId[])` — set each id to `{ mode: 'doing', expiresAt: now + DOING_TTL_MS }` (doing supersedes looking).
- `presenceMode(id: TLShapeId): PresenceMode | null` — reactive read used by the card component (safe to call inside a tldraw `track`ed render).
- Internal: per-entry `setTimeout` (tracked in a `Map`, reset on refresh) deletes the entry at `expiresAt` and updates the atom, so the glow fades out. `clearPresence()` for teardown/tests.

Constants (one place to tune feel):
`LOOKING_TTL_MS = 25_000`, `DOING_TTL_MS = 10_000`.

Uses `Date.now()` (browser code — the restriction on `Date.now()` is specific to workflow scripts, not app code).

### 2. `src/apply/applyChangeSet.ts` — return affected ids

Refactor each `applyX` helper to **return the `TLShapeId[]` it touched**, and have `applyChangeSet` collect and return the union. Contract per op ("what the user should see the agent just touched"):

- `add_comment` → `[cardId]`
- `merge_notes` → `[representativeId]` (the visible survivor)
- `move_cards` → moved card ids
- `create_note_card` / `create_reference` → the newly-minted id
- `create_section` → the new section id
- `move_sections` → moved section ids
- `edit_section_text` → `[sectionId]`
- `group_cards` → the member ids; `ungroup_cards` → the (pre-ungroup) child ids
- `set_summary` → `[cardId]` (returned for honesty, but the caller ignores summary-only change-sets)

Existing behaviour is unchanged — this only adds a return value. `squashToMark` still makes the whole change-set one undo step; presence lives outside the store so it is untouched by history.

### 3. `server/realtime.ts` — a second, presence message type

Add `broadcastPresence(projectId, presence)` alongside `broadcast(projectId, changeSet)`, sending `{ projectId, presence: { cardIds: string[]; mode: 'looking' } }` over the same `/ws` socket. Return it from `attachRealtime`.

### 4. `server/app.ts` — emit "looking" from the read route

`createServer` gains an optional `onPresence?(projectId, presence)` param. The `POST /projects/:id/cards` handler calls it with the requested ids and `mode: 'looking'` after resolving the project. `read_map` and every other route are unchanged.

### 5. `server/index.ts` — wire it

Pass `broadcastPresence` as `onPresence` into `createServer`.

### 6. `src/client/realtime.ts` — route both message kinds

`connectRealtime(onChangeSet, onPresence)` — parse the socket message and dispatch on which key is present (`changeSet` vs `presence`). Keeps one connection.

### 7. `src/App.tsx` — turn signals into glows

- Change-set handler: after `const affected = applyChangeSet(ed, cs)`, if the change-set has any non-`set_summary` op, call `markDoing(affected)`. (Existing `projectId`/`canvasLoaded` gates still apply.)
- New presence handler: on a `looking` message for the open project, `markLooking(ids.filter(id => ed.getShape(id)))` so only real, present shapes glow.

### 8. `src/shapes/CardShapeUtil.tsx` + `card.css` — render the glow

- In `component()`, read `presenceMode(shape.id)` and set `data-presence` on the `.elves-card-wrap` div. A single always-rendered child `<div className="elves-presence" aria-hidden />` carries the halo, so fade-out is a smooth opacity transition rather than a hard cut.
- CSS: `.elves-presence` is absolutely positioned (`inset: -2px`, rounded), `pointer-events: none`, `opacity: 0`, orange box-shadow halo.
  - `[data-presence="looking"]` → `opacity: 1` with a ~500ms transition (calm steady halo; fades out when the entry expires).
  - `[data-presence="doing"]` → a `10s` keyframe animation `elves-presence-doing`: bright pulse in the first ~0.6s, settle, then fade to 0 by 10s.
- New tokens in `theme.css`, derived from the existing Claude accent `oklch(0.62 0.17 45)`:
  `--elves-presence-ring: oklch(0.62 0.17 45 / 0.55)` and `--elves-presence-glow: oklch(0.62 0.17 45 / 0.35)`.
- `@media (prefers-reduced-motion: reduce)` → drop the pulse animation; show a steady halo that still fades on expiry.

Because the glow lives on `.elves-card-wrap` (whose `HTMLContainer` uses `overflow: visible`), the halo renders *outside* the card footprint and is not clipped, and it works uniformly for text, note, reference, and image cards.

## Edge cases

- **Merged/hidden cards** are removed from render by `getShapeVisibility`, so a glow on one won't show — glow the visible representative instead (handled by the `merge_notes` → representative contract).
- **Read of a card not on the open project / not yet loaded** — filtered out in the App handler (`getShape` guard).
- **Rapid re-reads** refresh the same entry's timer rather than stacking.
- **Doing over looking** — `markDoing` overwrites a `looking` entry so the action reads as the stronger signal; when it expires the card simply goes quiet (it does not revert to a stale looking halo).
- **Project switch** while glows are active — glows are keyed by shape id in the client store; switching projects unmounts those shapes so nothing bleeds across. (A `clearPresence()` on switch is a cheap belt-and-braces; include it.)

## Non-goals (YAGNI)

- Per-agent colours / multi-agent presence (only Claude authors today; one orange). The store is keyed so this can be added later by carrying an accent on the entry.
- A visible "Claude is looking…" label or cursor avatar.
- Persisting or replaying presence history.
- A user setting to toggle the glow (can be added trivially later if it proves distracting).

## Testing

- **`src/client/presence.test.ts`** — `markLooking`/`markDoing` set the expected mode; `doing` supersedes `looking`; entries expire after their TTL (fake timers); a refresh extends the timer; `clearPresence` empties the store.
- **`src/apply/applyChangeSet.test.ts`** — each op returns the correct affected ids (created ids included; merge returns the representative; ungroup returns former children).
- **`server`** — `POST /projects/:id/cards` invokes `onPresence` with the requested ids and `mode: 'looking'`; other routes do not; a 404 project does not emit.
- **e2e (optional, if time):** a Playwright check that a `looking` presence message applies `data-presence="looking"` to the target card wrap.
- `npm run typecheck`, `npm test`, and `npm run e2e` (existing suite) stay green.
