# Card snapping on the canvas

## Problem

Essays on an Elves canvas are almost always organised as vertical stacks of
cards, but nothing helps you build one. Every card is placed by eye, so columns
drift out of alignment and the gaps between cards vary card to card. Tidying a
canvas is manual pixel-nudging.

## What we're building

While you drag a single card, it snaps to a clean position relative to a nearby
card — directly below, above, to the right, or to the left — always at a
`CANVAS_GAP` separation, with the cross-axis edges aligned. Drag beyond the snap
radius and the card moves freely again.

`CANVAS_GAP` moves from 24px to **16px** as part of this change. It is the
canvas's one spacing constant, so this also tightens new-card placement, the
cascade offset for successive spawns, comment footprints, and the gap questions
keep from each other. Tests assert `<height> + CANVAS_GAP` rather than literal
coordinates, so the constant can be retuned again without a test rewrite.

## What we are deliberately NOT building

**No grouping.** Snapping is alignment only. Cards that snap together do not
become a unit: dragging one moves only that one, and there is no membership to
join or leave. "Remove a card from the stack" is just "drag it away" — it stops
snapping because it is out of range, and that is the whole mechanism.

This is a deliberate departure from the existing agent-facing `group_cards` /
`ungroup_cards` ops, which do create real tldraw group shapes with
travel-together semantics. Those stay exactly as they are. User-driven snapping
never creates, joins, or dissolves a tldraw group, and nothing new appears in
`read_map`'s `groups[]`.

**No width matching.** A snapped card keeps its own width. Only position changes.

**No multi-card snapping.** If two or more shapes are being translated at once,
snapping is off entirely. Bounding-box snap semantics are out of scope.

**No guide lines.** Alignment is shown by the halo below, not by rules or
measurements drawn between shapes.

## Design

### 1. Snap geometry — `src/model/layout.ts`

A new pure function alongside `conflictsWithGap` and `placeBelowObstacles`:

```ts
export function snapToNeighbours(
  dragged: LayoutRect,
  neighbours: LayoutRect[],
  radius: number,
  gap = CANVAS_GAP,
): { x: number; y: number; snappedTo: LayoutRect | null }
```

`snappedTo` reports which card was joined, so the caller can draw the halo
(section 5) without recomputing the match.

For each neighbour it generates four candidate top-left positions for the
dragged rect:

| Side   | x                              | y                              |
| ------ | ------------------------------ | ------------------------------ |
| below  | `n.x`                          | `n.y + n.h + gap`              |
| above  | `n.x`                          | `n.y - dragged.h - gap`        |
| right  | `n.x + n.w + gap`              | `n.y`                          |
| left   | `n.x - dragged.w - gap`        | `n.y`                          |

Below/above align **left edges**; right/left align **top edges**.

It returns the candidate with the smallest Euclidean distance from
`dragged`'s current top-left, but only if that distance is `< radius`.
Otherwise it returns `dragged`'s current top-left unchanged.

Ties (two candidates at identical distance) resolve to whichever comes first in
neighbour order, then in side order below → above → right → left. Deterministic,
and the case is vanishingly rare in practice.

The function is total and side-effect free: no editor, no tldraw types.

### 2. Snap radius is screen-space

The radius passed in is `SNAP_RADIUS_PX / zoomLevel`, where `SNAP_RADIUS_PX` is
40. A fixed page-space radius would feel dead when zoomed out and grabby when
zoomed in; converting through zoom keeps the pull consistent at any zoom.

### 3. Wiring — `src/shapes/CardShapeUtil.tsx`

`CardShapeUtil` already overrides `onRotate` and `onResize`; snapping adds
`onTranslate(initial, current)`, following the same pattern.

The override:

1. Bails out (returns nothing) if more than one shape is selected/translating.
2. Reads the dragged card's page rect and the other cards' + questions' rects
   via `canvasLayoutItems(editor, new Set([shape.id]))` — the existing adapter,
   which already excludes merged cards and dismissed questions.
3. Calls `snapToNeighbours`.
4. Converts the snapped page point back to parent space and returns
   `{ x, y }` as a `TLShapePartial<CardShape>`.
5. Publishes the halo box (or null) to the `snapHighlight` signal.

`onTranslateEnd` and `onTranslateCancel` clear the signal so the halo never
outlives either a completed or cancelled drag.

Because `onTranslate` runs each frame and derives position purely from the
cursor, the snap needs no state and nothing to unwind when the drag ends.

Neighbour rects use the same height convention `cardLayoutItems` already
applies — `bounds.h + commentH` — so a card snaps below the *visual* bottom of a
card that has comments hanging off it, not below the card box alone.

Cards snap to other cards and to questions, but **not to sections**. This
follows `canvasLayoutItems`, which already treats sections as outside the
layout system. If snapping a card under a section label turns out to be wanted,
it is a separate change to that adapter.

### 4. Stack upkeep — `src/shapes/CardShapeUtil.tsx`

`reflowCardLane` already runs when a card's *comment* height changes
(`CardShapeUtil.tsx:474`), pushing the cards below it down to preserve the gap.
`AutosizeCard` (`CardShapeUtil.tsx:296-310`) updates `props.h` when text grows
but does not reflow, so text growth silently overlaps the card below.

Fix: capture the previous height before the `props.h` update and call
`reflowCardLane(editor, cur.id, previousHeight)` inside the same
`editor.run(..., { history: 'ignore' })`, mirroring the comment-height path.

This is what makes a snapped column stay a column while you write into it.

When a card is dropped into an occupied snap slot, `onTranslateEnd` also uses
`reflowCardLane` with the dropped card as the anchor. The existing occupant and
its contiguous lane move down, inserting the dropped card without overlap.

### 5. Snap affordance — the halo

A live snap draws a low-opacity green field behind BOTH cards, so the pairing is
visible before the drop and disappears the moment the card leaves range. That
disappearance is the only feedback that says "this is no longer snapped", which
matters because there is no group membership to show.

- `snapHalo(a, b, pad)` in `model/layout.ts` — pure: the padded box containing
  two rects.
- `client/snapHighlight.ts` — a tldraw `atom` holding that box, or null. A
  signal rather than React state because it is written from `onTranslate`, which
  runs outside React on every frame of a drag.
- `shapes/SnapHighlight.tsx` + `snap.css` — mounted as tldraw's `OnTheCanvas`
  component, which renders in page space and *behind* the shapes, so the two
  cards read as sitting on one shared surface rather than being outlined
  separately. Fades in over 120ms; position is never animated, or the box would
  lag the cursor. `pointer-events: none`, and the fade is dropped under
  `prefers-reduced-motion`.
- Colour comes from two new theme tokens, `--elves-snap-fill` /
  `--elves-snap-border`, in the palette's existing green (hue 152).

## Testing

**Unit — `tests/model/layout.test.ts`** (extending the existing file):

- Snaps below when dropped just under a card; result is exactly `gap` below and
  left-aligned.
- Snaps to right/left/above at the correct offsets with the correct edge aligned.
- Returns the input position unchanged when the nearest candidate is outside the
  radius.
- Picks the nearer of two competing neighbours.
- Empty neighbour list returns the input unchanged.
- `snappedTo` names the joined card, and is null when nothing was joined.
- `snapHalo` contains both rects with padding, including an unequal-height
  side-by-side pair.

Every expectation is written as `<height> + CANVAS_GAP`; the suite passes at
gap 16, 24, and 32, which is the check that the constant is genuinely a knob.

**E2E — `e2e/card-snapping.spec.ts`:**

- Drag a card near another; on release its position is exactly one gap below
  with matching left edge.
- Type into the top card of a snapped column; the card below is pushed down and
  the gap survives.
- The halo appears mid-drag, contains both cards, vanishes when the card is
  dragged back out of range, and is gone after Escape cancels the drag.
- Dropping a third card into an occupied slot inserts it into the column and
  pushes the former occupant down by one card height plus the gap.
- Drag a snapped card far away; it lands where dropped, unsnapped.

The original snap and growth behaviours were mutation-checked: with
`SNAP_RADIUS_PX` forced to 0 the snap test fails by exactly the offset it aims
off by, and with the new `reflowCardLane` call removed the growth test fails
with a 63px overlap.

**Regression:** existing `tests/server/grouping.test.ts` must still pass
untouched — snapping does not disturb agent-created groups.

## Risks

- **Snapping fights precise placement.** A 40px screen-space radius is a guess.
  If it feels grabby in use, the constant is the one knob to turn.
- **`onTranslate` returning a partial every frame** could interact with tldraw's
  own drag bookkeeping. If the card judders, the fallback is to snap on
  `onTranslateEnd` only — a smaller behaviour, same geometry function.
- **Reflow on text growth is a behaviour change** beyond snapping: cards below a
  growing card will now move on canvases that never had snapping applied. This
  is intended (it is what keeps columns tidy), but it is the change most likely
  to surprise.
- **Autosize height updates are no longer undoable.** Wrapping the `props.h`
  update in `editor.run(..., { history: 'ignore' })` — needed so the reflow it
  triggers is not a separate undo step — also takes the height change itself out
  of the undo stack. This matches the comment-height path exactly and is
  arguably a fix (autosize height is derived state; undoing into a stale height
  was never useful), but it is a side effect of this change, not a goal of it.
- **Occupied slots insert into the lane.** This is more spatially active than
  rejecting the snap, but it preserves the user's chosen slot and guarantees
  the completed drop does not leave cards overlapped.
