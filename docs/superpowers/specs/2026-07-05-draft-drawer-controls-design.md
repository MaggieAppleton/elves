# Draft drawer controls

**Date:** 2026-07-05
**Status:** Approved design, ready for planning

## Problem

The Canvas / Split / Draft view switcher is a three-button segmented control floating at
top-center (`ViewToggle.tsx`, mounted in `App.tsx:499`). Every view change means aiming for
one of three equal-weight destination buttons. It reads as a mode picker, not as a natural
progression, and it sits awkwardly above the card-creation toolbar.

The desired mental model is a **drawer**: the draft slides out from the right edge into a split,
the drawer widens to fill the screen, then narrows back to split, then closes. Controls should be
about *pushing the drawer out and pulling it back in* — directional — rather than jumping between
three absolute modes.

## Core insight

The layout already behaves like a sliding drawer. tldraw stays mounted in all three states and the
app CSS-transitions the pane widths (`App.tsx:494-495`, 320ms transition in `theme.css`). The state
is a clean 1-D sequence with a resize ratio:

```
canvas  <->  split  <->  draft(full)
```

So this is a **presentation swap**, not a layout rewrite. We replace the three-button control with a
directional handle attached to the drawer's left edge. The underlying state machine
(`view: 'canvas' | 'split' | 'draft'` plus `split` ratio, both persisted per-project) is untouched.

## Control model

Two directions, one handle anchored to the draft's left edge, travelling with it. Each chevron
points in the direction its edge will move:

- **«** = "more draft" — the drawer's leading (left) edge sweeps left. `canvas → split → draft`.
- **»** = "less draft" — the edge sweeps right. `draft → split → canvas`.

At each state we show only the reachable chevrons:

| State      | Drawer                    | Handle location                     | Chevrons        | Targets                    |
|------------|---------------------------|-------------------------------------|-----------------|----------------------------|
| **canvas** | closed (off right edge)   | slim vertical **tab** on right edge | `«`             | `«` → split                |
| **split**  | right pane, resizable     | rides the divider, at its **top**   | `«` and `»`     | `«` → draft, `»` → canvas  |
| **draft**  | fills screen              | parks **top-left**                  | `»`             | `»` → split                |

Stepwise only: each press moves exactly one step along the sequence. `draft --»--> split --»--> canvas`.

## Visuals & motion

- **Handle**: a small pill (~24px wide) holding the chevron(s), in the app's existing quiet card
  aesthetic — subtle 1px border (`--elves-border`), soft shadow, no fill. In split it is a vertical
  pill positioned near the **top** of the divider so it never overlaps card/reading content. In full
  it is a single `»` pill at top-left. In canvas it is a half-visible tab clinging to the right screen
  edge that slides fully into view on hover.
- **Motion**: reuses the existing 320ms pane width transition so the drawer *slides*. The handle rides
  along because it is positioned relative to the drawer edge / divider. Honours
  `prefers-reduced-motion` (cross-fade instead of slide).
- **Split divider**: the draggable divider is **kept** for fine-grained resizing (`onDividerDown`,
  `App.tsx:213-231`). Chevrons drive the big state jumps; dragging changes only the `split` ratio.

## Accessibility

- Each chevron is a real `<button>` with a descriptive `aria-label`:
  - canvas tab → "Open draft"
  - split `«` → "Expand draft to full", split `»` → "Close draft"
  - full `»` → "Collapse draft to split"
- Buttons are keyboard-focusable with `title` tooltips. The divider keeps
  `role="separator"` / `aria-orientation="vertical"`.

## Keyboard

Replace the blind cycle with directional shortcuts (currently `⌘/Ctrl + \` cycles forward,
`App.tsx:196-207`):

- `⌘/Ctrl + \` → more draft (`«`)
- `⌘/Ctrl + Shift + \` → less draft (`»`)

Both no-op at the ends of the sequence. A modifier stays required so it never interferes with typing
in a card.

## Preserved behaviors

- Clicking a paragraph in full-draft still drops to split (`onSelectCard`, `App.tsx:246-253`).
- Per-project persistence of `view` and `split` ratio (`elves:view:<id>`, `elves:split:<id>`).
- The card-creation toolbar and drawing-tools toggle remain gated on `view !== 'draft'`.

## Code changes

- **New** `src/components/DraftDrawerControls.tsx` — the chevron handle. Receives `view`,
  `expand`, `collapse` (and the small booleans for which chevrons are reachable) and renders the
  right chevrons for the current state. The `ViewState` / `VIEW_ORDER` types move here (or into a
  small shared module) since `ViewToggle` is being retired.
- **Remove** `src/components/ViewToggle.tsx` and `src/components/viewToggle.css`.
- **`App.tsx`**:
  - Replace `<ViewToggle view={view} onChange={changeView} />` (line 499).
  - Render the canvas tab and full-draft `»` handle inside the stage relative to the panes; render
    the split handle attached to the top of the divider block (lines 559-568).
  - Add `expandDraft()` / `collapseDraft()` helpers that step one position through `VIEW_ORDER`
    via the existing `changeView`.
  - Update the keyboard handler (196-207) to the directional shortcuts above.
- **CSS**: add handle/tab styles to `theme.css` near the existing `.elves-divider` and pane rules
  (229-296) so motion tokens are shared; delete `viewToggle.css` and its import.

## Testing

- Existing tests target the old toggle testids (`view-toggle`, `view-canvas`, `view-split`,
  `view-draft`). Add stable testids to the new chevrons — `draft-open` (canvas tab),
  `draft-expand` (`«`), `draft-collapse` (`»`) — and update selectors in the unit/e2e specs.
- Cover the sequence: canvas → (open) → split → (expand) → full → (collapse) → split →
  (close) → canvas, asserting pane widths / `data-*` at each step, plus the directional keyboard
  shortcuts and that drag-to-resize still adjusts the ratio in split.

## Out of scope

- No change to the underlying view state machine or persistence.
- The "Augment Essay" dropdown shown in some screenshots does not exist in this source tree; left
  untouched.
