# Elves Phase 2 — Design Spec (Claude on the Canvas)

- **Status:** Design approved, ready for implementation planning
- **Date:** 2026-07-01
- **Builds on:** Phase 1 (canvas skeleton) — see [`2026-07-01-elves-design.md`](./2026-07-01-elves-design.md) and [`2026-07-01-elves-mvp-phase1-plan.md`](./2026-07-01-elves-mvp-phase1-plan.md).

---

## 1. Summary

Phase 2 brings Claude onto the canvas as a participant with a **hard capability boundary**. Claude can **comment** on cards (typed or freeform), **dedupe** duplicate source cards, and **reorder** cards along the narrative axis — all as *direct, undoable* changes you watch happen — but it can **never write your prose**. Everything Claude does is a normal tldraw store operation, so a single Ctrl‑Z reverts it, and the operations it's allowed to emit simply don't include "edit card text."

The interaction is turn-based: you work at the open canvas, ask Claude in Claude Code ("review my prose for weak spots," "dedupe my sources," "does my ordering flow?"), and watch the changes land.

---

## 2. Goals & non-goals

### Goals
- **Comment** — Claude adds comments to cards, optionally typed (`needs-evidence` · `weak-argument` · `needs-citation`) or freeform. You resolve/dismiss them.
- **Dedupe** — Claude collapses duplicate *source* cards under a representative it picks.
- **Reorder** — Claude moves cards/groups along the x-axis (left = earlier, right = later).
- **Cluster** — Claude moves related source cards into proximity (a special case of reorder/move).
- All of Claude's changes are **direct and natively undoable** (Ctrl‑Z), and applied live in the open app.
- The "Claude never writes prose" rule is **structurally enforced** by the operation vocabulary.

### Non-goals (deferred)
- **Tags** and **suggest-links** — deferred (you prioritized comments/dedupe/reorder).
- **Images / vision** — Phase 3.
- **Tana bulk import, MDX export** — later, per the Phase 1 spec.
- **Contradiction-over-time** — needs provenance/dates that mostly arrive with Tana import; deferred.
- **Live co-presence / multi-user** — turn-based only; no realtime shared cursors.
- Claude **creating or editing prose cards**, or editing the text of any existing card.

---

## 3. Core principles

Carried from Phase 1, plus the two that Phase 2 adds:

1. **Claude never writes your prose — structurally.** Now enforced two ways: (a) the operation vocabulary Claude can emit has no "edit card text" op; (b) the server re-checks the Phase 1 `claudeMayEditCardText` invariant before applying any op.
2. **Everything Claude does is a tldraw store operation.** This is what makes "watch it happen + plain Ctrl‑Z undo" true for free — Claude's changes ride the same store and history as your own edits.
3. **Turn-based, app open.** Claude's changes apply in the running app. You're present and watching.
4. **Authorship is always visually distinguishable.** Comments render as unmistakably Claude-styled; your words stay yours.
5. **The x-axis is narrative order** (see §4).

---

## 4. The narrative x-axis

Horizontal position on the canvas **is** the sequence of the piece: **left = earlier, right = later.** Claude reads a card's x-position as its place in the narrative and reasons about "this belongs before that" as "move it left of that." Vertical position remains free for your own grouping. This makes "reorder" a concrete, mechanical operation: to bring a point earlier, move it left.

---

## 5. Claude's operation vocabulary (the capability boundary)

Claude can emit **only** these operations. The list *is* the boundary.

| Operation | Effect | Card kinds | Touches text? |
|---|---|---|---|
| `read_canvas` | Read the current canvas (cards, positions, comments) | all | no |
| `add_comment` | Attach a comment (typed or freeform) to a card | prose or source | no |
| `merge_sources` | Collapse duplicate source cards under a representative | **source only** | no (see §7) |
| `move_cards` | Move one or more cards to new positions (reorder/cluster) | prose or source | no |

There is **no operation that writes any card's text** — not prose, not source. Comments are a separate field (§6), merges rewrite nothing (§7), and moves only change position. Every existing card's text is untouchable. (Claude *creating* new source cards — e.g. splitting a dense note, or deriving cards from an image — is deferred to Phase 3.)

---

## 6. Comments model

A comment is Claude-authored and attached to a card:

```
Comment {
  id: string
  type: 'needs-evidence' | 'weak-argument' | 'needs-citation' | null   // null = freeform
  text: string
  resolved: boolean            // resolved/dismissed → hidden (kept, recoverable)
  author: 'claude'
}
```

- **Storage:** comments live as a `comments: Comment[]` prop on the card shape (a small tldraw shape-props **migration** adds `comments: []` to existing Phase 1 canvases). Because they're card props, they follow the card, ride the same undo, and persist through the same save path.
- **Rendering:** an unmistakably Claude-styled pin/badge on the card, **color-coded by type**, expanding to show the text. Never confusable with your own card text.
- **Resolve/dismiss:** you mark a comment resolved and it **disappears**. Resolved comments are kept (hidden) rather than hard-deleted, so a future "show resolved" toggle is trivial. Resolving is a human action in the app (not a Claude op).

---

## 7. Dedupe / merge semantics

`merge_sources(cardIds[])` **collapses duplicates under a representative** card that Claude picks from the set:

- The representative keeps **its own original text** — **no text is rewritten or synthesized.**
- The other duplicates are **hidden (recoverable)** and linked to the representative as provenance (e.g. a `mergedInto` reference), so nothing is lost and a merge is reversible.
- Applies to **source cards only.** Prose cards are never merged by Claude.

This keeps Claude away from authoring even *source* text during a merge — a merge is a purely structural collapse.

---

## 8. Reorder & cluster

`move_cards(moves[])` sets new positions for one or more cards in a single change-set:

- **Reorder:** shift a card or group left (earlier) / right (later) along the narrative x-axis.
- **Cluster:** move related source cards into spatial proximity (same op, just grouped destinations).
- Multiple cards move together in one undoable step, so "move this group earlier" is one Ctrl‑Z.

---

## 9. Architecture (Approach 1)

```
You (app, open) ──edits──► tldraw store ──debounced save──► canvas.json (Elves server)
                                 ▲
Claude (Claude Code) ──MCP tools──► Elves server ──websocket: change-set──► app
                                                        applies as ONE undoable
                                                        tldraw transaction, then saves
```

- **Claude's channel is a scoped MCP server** exposed by the Elves server. The MCP tool list *is* the capability boundary (the four ops in §5). Claude Code connects to it, reads the canvas, and emits a **change-set**.
- **A change-set** is an ordered list of typed ops. The server relays it to the open app over a **websocket**.
- **The app applies the whole change-set as a single undoable tldraw transaction** (grouped so one Ctrl‑Z reverts it), then persists via the existing save path. The app is the only writer to the tldraw store — no file clobber.
- **Enforcement** lives in two places: the MCP tool surface has no text-edit op, and the server re-checks `claudeMayEditCardText` (Phase 1) before relaying any op that targets card text-bearing fields.
- **Reads are turn-based:** `read_canvas` returns the current `canvas.json`; the app's debounced saves keep it current between turns (you've settled before you ask Claude). Tightening to a live-store read is a later option.

The existing Phase 1 server (`GET`/`POST /canvas`) and app persistence are extended, not replaced. New surface: the websocket, the change-set relay + MCP tools (server), and the change-set applier + websocket client (app).

---

## 10. Data model additions

- **`CardProps` gains `comments: Comment[]`** (default `[]`), added via a tldraw shape-props migration so existing canvases load cleanly.
- **`Comment`** as defined in §6.
- **Change-set / op schema** (server ↔ app contract), one variant per op in §5, e.g.:
  ```
  ChangeSet = { id, author: 'claude', ops: Op[] }
  Op =
    | { kind: 'add_comment', cardId, comment: { type, text } }
    | { kind: 'merge_sources', cardIds: string[] }        // cardIds[0] is the representative
    | { kind: 'move_cards', moves: { cardId, x, y }[] }
  ```
- **Merge provenance:** a hidden duplicate records `mergedInto: <representativeId>` (recoverable).

The exact split between tldraw shape props and any change-set metadata is finalized in the implementation plan; the invariant is that the applier can turn any op into store mutations and that no op path writes an existing card's `text`.

---

## 11. Rendering & authorship distinction

- **Comments:** Claude-styled pins on cards, color-coded by type, with resolve/dismiss; expand to read.
- **Merge:** duplicates collapse under the representative with a subtle "merged by Claude — N sources" affordance; recoverable.
- **Reorder/cluster:** cards move to their new positions (you see the change); Ctrl‑Z reverts.
- At every point, what you wrote and what Claude contributed are visually unambiguous.

---

## 12. Sub-phasing (build order)

Mirrors Phase 1 — build the surface, then wire the intelligence.

### Phase 2a — the canvas side (no Claude)
- Add the `comments` prop + migration; render comments (typed/freeform, color-coded) with resolve/dismiss (hidden-recoverable).
- Add the websocket + **change-set applier** that applies a change-set as a single undoable transaction and persists.
- Implement merge (collapse-under-representative, recoverable) and move as store operations.
- **Driven by a test harness** that injects change-sets over the same channel — no Claude required.
- **Done when:** injected change-sets (comment / merge / move / create-source) apply live, render correctly, are undoable with one Ctrl‑Z each, resolve/dismiss works, and it all persists across reload.

### Phase 2b — the Claude side
- The scoped **MCP server** exposing the four ops; the **Claude skill** that reads the canvas and emits change-sets, with the capability boundary documented for Claude.
- **Done when:** from Claude Code, "comment on weak spots," "dedupe my sources," and "reorder for flow" produce correct change-sets that land in the open app, and there is no path by which Claude edits card text.

Build **2a first**; each is separately shippable and testable.

---

## 13. Out of scope for Phase 2
Tags · suggest-links · images/vision · Tana import · MDX export · contradiction-over-time · live co-presence · multi-user · Claude creating source cards (Phase 3) · Claude authoring/editing any card text.

---

## 14. Future / open questions
- **Tags & suggest-links** (deferred from this phase).
- **Contradiction-over-time** once Tana provenance/dates exist.
- **Synthesis-merge** as an optional alternative to collapse-merge.
- **Claude creating source cards** (splitting a dense source; deriving from an image) — arrives with Phase 3.
- **tldraw bound groups** for moving true groups (Phase 2 uses multi-card moves).
- **Live-store reads** instead of file reads, if turn-based settling proves insufficient.
- Images (Phase 3), MDX export, multi-device.

---

## 15. Decisions log (blessed during design)
- Phase 2 capabilities: **comments** (typed/freeform, resolvable), **dedupe** (merge sources), **reorder** (x-axis moves), **cluster** (moves). Tags & suggest-links **deferred**.
- Comments are a **subtype-unified** concept: one comment kind with an optional type (`needs-evidence`/`weak-argument`/`needs-citation`).
- Structural changes are **direct + natively undoable** (Approach 1), not proposals; the user requires undo.
- **Everything Claude does is a tldraw store op** → native Ctrl‑Z undo.
- **x-axis = narrative order** (left earlier, right later), first-class.
- Comments stored as a **card `comments[]` prop** (with a shape-props migration).
- Merge = **collapse duplicates under a representative** (no text rewritten; originals hidden-recoverable), **source cards only**.
- Claude's channel: a **scoped MCP server**; change-sets relayed to the open app over **websocket**; applied as one undoable transaction.
- Enforcement: **operation vocabulary** (no op writes any card text) + server-side `claudeMayEditCardText` guard.
- Split into **Phase 2a (canvas side, test-harness-driven) → Phase 2b (MCP + skill)**; build 2a first.
