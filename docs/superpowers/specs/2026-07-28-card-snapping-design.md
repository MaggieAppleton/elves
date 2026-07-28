# Card snapping on the canvas

## Problem

Essays on an Elves canvas are almost always organised as vertical stacks of
cards, but nothing helps you build one. Every card is placed by eye, so columns
drift out of alignment and the gaps between cards vary card to card. Tidying a
canvas is manual pixel-nudging.

## What we're building

While you drag a single card, it snaps to a clean position relative to a nearby
card — directly below, above, to the right, or to the left — always at a
`CANVAS_GAP` (24px) separation, with the cross-axis edges aligned. Drag beyond
the snap radius and the card moves freely again.

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

**No snap indicator.** The card visibly moving into place *is* the feedback. No
guide lines, no highlight on the target card.

## Design

### 1. Snap geometry — `src/model/layout.ts`

A new pure function alongside `conflictsWithGap` and `placeBelowObstacles`:

```ts
export function snapToNeighbours(
  dragged: LayoutRect,
  neighbours: LayoutRect[],
  radius: number,
  gap = CANVAS_GAP,
): { x: number; y: number }
```

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

## Testing

**Unit — `tests/model/layout.test.ts`** (extending the existing file):

- Snaps below when dropped just under a card; result is exactly `gap` below and
  left-aligned.
- Snaps to right/left/above at the correct offsets with the correct edge aligned.
- Returns the input position unchanged when the nearest candidate is outside the
  radius.
- Picks the nearer of two competing neighbours.
- Empty neighbour list returns the input unchanged.

**E2E — `e2e/card-snapping.spec.ts`:**

- Drag a card near another; on release its position is exactly 24px below with
  matching left edge.
- Drag a snapped card far away; it lands where dropped, unsnapped.

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
