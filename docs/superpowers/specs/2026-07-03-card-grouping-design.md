# Grouping cards — design

**Date:** 2026-07-03
**Status:** approved, implementing

## Goal

Let a set of cards be **grouped** so they travel together on the canvas — the
same behaviour tldraw ships (select cards → Group → they move as one). Grouping
must be available to **both** the human (on the canvas) and **Claude** (via the
MCP), and Claude must be able to **read** that a set of cards is grouped when it
maps the canvas, then drill into the members if it cares.

The motivating cases: a reference/link card that should always ride alongside
the note it annotates; a tight narrative cluster of cards that must stay adjacent
when the piece is rearranged.

## Decisions (locked during brainstorming)

1. **A group is a mechanical binding only** — "these N cards move together." No
   label, no meaning, no typed kinds. Claude infers *why* from the member cards.
2. **Model it with tldraw's native group shape**, and *derive* a clean,
   absolute-coordinate view for the MCP. Not a custom `groupId` card prop.
3. **Human side is zero-build** — rely on tldraw's stock Group UI (`Cmd+G` /
   `Cmd+Shift+G` / right-click Group·Ungroup), which the app already exposes via
   its plain `<Tldraw>`.
4. **The map surfaces `groups[]` + a `groupId` back-reference on each card**,
   mirroring how `sections[]` already works.

## Background: how the canvas is shaped today

- The canvas is a **tldraw store** persisted per project as `canvas.json`. Cards
  and section-headers are tldraw *shapes*. Sections are purely spatial labels —
  no membership link to cards.
- **Claude never mutates the store directly.** It posts typed `ChangeSet` ops;
  each is guarded by `changeSetWritesText()` so Claude can never write prose.
- Reads are layered: `read_map` (`snapshotToCardMap`) is the cheap first pass
  (`{id, kind, x, y, gist, textLen}` per card + `sections[]`); `read_cards`
  (`snapshotToCardsById`) is the full drill-down.
- There are **two apply paths**: `src/apply/applyChangeSet.ts` (live tldraw
  `Editor`, exact) and `server/applyChangeSet.ts` (headless, operates on the raw
  `canvas.json` JSON when no tab is open to that project).

## The one load-bearing fact

In tldraw a shape's `x`/`y` are in its **parent's** coordinate space. Top-level
shapes' parent is the page, so `x`/`y` are page coords — which is what every
existing digest assumes. A **grouped** shape's parent is the `group` shape, so
its `x`/`y` become **group-local**. `editor.groupShapes()` creates the group at
the top-left of the members' common page bounds and reparents each child to
`pageCoord − groupOrigin`.

**Invariant we rely on:** groups of cards are never rotated (cards are
axis-aligned and we never rotate a group), so page position resolves by *additive*
`parentId` walking: `pageX = shape.x + parent.x + …` up to the page. If a group
were ever rotated this additive shortcut would be wrong — the live path is exact
(it uses the editor); only the headless path takes the shortcut, and it is only
ever fed axis-aligned groups.

## Design

### 1. Human side — nothing to build
Stock tldraw grouping already works and already round-trips through whole-store
snapshot persistence. We add **one persistence round-trip test** (group a canvas,
save, reload, assert membership + geometry survive) and leave the native UX alone.

### 2. Model: two new change-set ops
In `src/model/changeset.ts`:

```ts
| { kind: 'group_cards'; cardIds: string[] }      // ≥2 ids
| { kind: 'ungroup_cards'; groupId: string }
```

- `changeSetWritesText()` returns **false** for both (structural, never text —
  same safety class as `move_cards`).
- `isOp()` validates: `group_cards` needs a string array; `ungroup_cards` needs a
  string `groupId`.
- `referencedCardIds()` includes `group_cards.cardIds` (so the server's
  project-scoping check rejects a group op that names a card from another
  project). `referencedSectionIds()` unchanged.
- `ungroup_cards.groupId` references a group shape, not a card; the server's card
  and section scope checks simply don't cover it (a stray id is a no-op in apply),
  which is acceptable — worst case an unknown group id does nothing.

### 3. Derive layer — page-coord resolution + `groups[]` (`server/digest.ts`)

- Add `resolvePageXY(store, shape)`: walk `parentId` from the shape to the page,
  summing `x`/`y` (depth-guarded against cycles). For a top-level shape this
  returns `shape.x/shape.y` unchanged, so nothing regresses.
- Route **every card digest's** `x`/`y` through it — `snapshotToCards`
  (line 80/81) and `snapshotToCardMap` (line 114/115). Sections are always
  top-level but are routed through it too for uniformity/robustness.
- Extend `CardMap`:
  ```ts
  interface GroupDigest { id: string; cardIds: string[]; memberCount: number;
                          bounds: { x: number; y: number; w: number; h: number } }
  interface CardMapEntry { …; groupId?: string }   // omitted when ungrouped
  interface CardMap { cards: CardMapEntry[]; sections: SectionDigest[]; groups: GroupDigest[] }
  ```
  `groups[]` = one entry per `type:'group'` shape: its direct **card** children's
  ids, count, and the union of their resolved page bounds. Each grouped card's
  entry carries `groupId` = its immediate group parent. (Nested groups: reported
  flat — each group listed, each card points at its immediate parent. Fine for a
  mechanical binding.)

### 4. Apply the ops — both paths

**Headless (`server/applyChangeSet.ts`)** — replicate tldraw's geometry exactly:
- `group_cards`: resolve each member's page x/y; group origin = `(min pageX,
  min pageY)`; mint a `type:'group'` shape (`props:{}`, `parentId` = page,
  `index` above the top) at that origin; reparent each member to the group with
  local `x/y = pageXY − groupOrigin`. Require ≥2 resolvable members or it's a
  no-op.
- `ungroup_cards`: for each shape parented to the group, reparent to the page and
  restore `x/y += groupOrigin`; delete the group record.
- `move_cards`: convert a grouped target's absolute page x/y to local
  (`target − parentOrigin`) before writing, so Claude keeps passing page coords
  everywhere. Top-level cards are unaffected.

**Live (`src/apply/applyChangeSet.ts`)** — use the editor, which is exact:
- `group_cards` → `editor.groupShapes(cardIds)`.
- `ungroup_cards` → `editor.ungroupShapes([groupId])`.
- `move_cards` → convert the page point to parent space for grouped shapes
  (`editor.getPointInParentSpace`) before `updateShape`; unchanged for top-level.

### 5. MCP tools (`mcp/tools.ts` + `mcp/index.ts`)
- `group_cards { project, cardIds }` and `ungroup_cards { project, groupId }`,
  each posting the matching op via `makeChangeSet`.
- Descriptions in the same voice as the section tools, baking in the guiding
  example: *"group a note with the reference cards that annotate it so they travel
  together; the first pass `read_map` shows a `groups[]` list and a `groupId` on
  each member so you can see what is already bound."*

## Non-goals (YAGNI)
- No group label / name / typed kinds (decision 1).
- No `move_group` op — to shift a whole group Claude moves its member cards (or
  the human drags the group). The map's group `bounds` give Claude what it needs.
- No custom canvas styling for groups in this pass (decision 3); tldraw's native
  group affordance is enough. Revisit if it clashes with the app's look.

## Edge cases
- tldraw **auto-dissolves** a group under 2 members; the derive layer just reports
  whatever groups currently exist, so deletes/ungroups need no special handling.
- A merged/hidden card inside a group still carries `mergedInto`; membership and
  merge are orthogonal.
- Nested groups resolve correctly (full chain walk) and report flat.
- Unknown `groupId` on `ungroup_cards`, or `<2` members on `group_cards`: no-op.

## Testing
- **Model:** op validation; `changeSetWritesText` false for both;
  `referencedCardIds` includes group members.
- **Digest:** `resolvePageXY` for top-level, grouped, nested; `groups[]` +
  `groupId` emitted; ungrouped cards have no `groupId`.
- **Apply — headless:** group → member reparented + local coords correct;
  ungroup restores page coords + removes group; `move_cards` on a grouped card
  lands at the right page coord; round-trips through the digest.
- **Apply — live:** group/ungroup via a real editor; digest of the resulting
  snapshot matches the headless result.
- **Persistence:** group a canvas → save → reload → membership + geometry intact.
- Full `npm test` green.
