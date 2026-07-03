# Merged cards: kill the ghost, show a stack, peek on demand

**Date:** 2026-07-03
**Status:** Approved, implementing

## Problem

When Claude merges duplicate note/source cards, only the representative card
stays visible with an `⊕ N merged` badge; each merged-away card keeps its data
but its `mergedInto` pointer is set. Today `CardShapeUtil.component()` renders a
merged card as an **empty `<HTMLContainer/>`** (`CardShapeUtil.tsx:184`). The
shape still has full `getGeometry` bounds, so tldraw treats it as a real,
selectable, space-occupying shape that simply draws nothing — an invisible
**ghost card** sitting wherever the merged card originally was (often on top of
neighbours). Deleting the ghost silently removes one member of a merge.

We want the merged cards to be *shown*, not hidden into a ghost:
1. A subtle **stack** under the representative signals "there's more here."
2. Clicking the **`N merged` badge** fans the merged cards out to the right so
   you can read what got collapsed.

## Decisions (from brainstorming)

- **Expanded state is a temporary peek** — ephemeral, never persisted, resets on
  reload; like selection.
- **Fan-out is view-only** — shows each merged card's full text. No un-merge, no
  per-card delete this iteration. (With ghosts properly hidden, the old
  "select the ghost and delete" workaround is unnecessary.)
- **Stack look:** subtle, fixed 1–2 offset card-edges (not count-scaled).

## Approach

Merge is already non-destructive — every merged card's data still lives on the
canvas. So the **representative card's own component** draws both the stack and
the fan-out by looking up its members; the merged shapes themselves become
hidden data-holders. No new persisted data, no new shapes.

### 1. Kill the ghost — true hiding

Add `getShapeVisibility` to `<Tldraw>` (App.tsx): a card with `mergedInto` set
returns `'hidden'`, which removes it from **both** rendering and hit-testing.
The empty-`<HTMLContainer/>` branch in `CardShapeUtil.component()` is deleted
(dead once the shape is never rendered).

### 2. Ephemeral expanded state — `src/shapes/mergeView.ts` (new)

A tldraw `atom<Set<string>>` of representative ids that are fanned out, plus pure
helpers (`isExpanded`, `toggleExpanded`, `collapseAll`) and a pure
`cardIsHidden(shape)` predicate (used by `getShapeVisibility`) and
`mergedMembers(shapes, repId)` filter. All unit-testable without an editor.

### 3. Representative renders stack + fan-out — `CardShapeUtil.tsx`

- Compute `mergedMembers` once (reactive via `getCurrentPageShapes`); count = len.
- The `⊕ N merged` badge becomes a `<button>`: `onPointerDown` stops propagation
  (so clicking it doesn't drag/select the card), `onClick` calls
  `toggleExpanded(shape.id)`. Applied in both the note and reference branches.
- **Stack:** when `count > 0 && !expanded && !showGist`, render `min(count, 2)`
  `.elves-merge-stack__edge` divs behind the card (offset down-right, CSS only).
- **Fan-out:** when `expanded && count > 0`, render `.elves-merge-fan`
  absolutely positioned to the right of the card, one read-only
  `.elves-merge-fan__card` per member showing its full `text`. Members
  `stopPropagation` on pointer-down so reading them doesn't grab the canvas.

### 4. Collapse on outside click — App.tsx `handleMount`

`editor.on('event', ...)`: a `pointer_down` on target `canvas` calls
`collapseAll()`, so the peek dismisses like a popover. Clicking the badge again
also toggles it closed.

### 5. Styling — `card.css`

`.elves-merged` gets button-reset + pointer cursor + hover. New
`.elves-merge-stack__edge` (thin offset paper edge, layered behind the card via
z-index) and `.elves-merge-fan` / `.elves-merge-fan__card` (a small column of
muted note-styled cards to the right).

## Testing

- **Unit** (`tests/shapes/mergeView.test.ts`): `toggleExpanded`/`isExpanded`/
  `collapseAll` transitions; `cardIsHidden` true iff `mergedInto` set;
  `mergedMembers` filters by representative id.
- **e2e** (extend `e2e/changes.spec.ts` merge test): after merge, the merged
  card is not selectable (ghost gone) and exactly one source card is visible;
  the stack edge renders; clicking `merged-badge` reveals the member's text to
  the right (`merge-fan`), clicking again collapses it.

## Out of scope

Un-merge, per-card delete, persisted expansion, count-scaled stacks.
