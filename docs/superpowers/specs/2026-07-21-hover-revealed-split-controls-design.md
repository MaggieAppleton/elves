# Hover-Revealed Split Controls Design

## Problem

The paired draft chevrons sit permanently over the canvas/draft border in split view. They are useful when moving between canvas, split, and draft views, but visually interrupt the draft while idle.

The controls should appear when the pointer is near the shared edge. They must remain reachable by keyboard and touch, and the draggable divider must continue to work.

## Scope

This change affects only the paired chevron pill shown in split view.

- The canvas-only draft tab stays visible.
- The draft-only collapse control stays visible.
- The existing view-state transitions, keyboard shortcuts, split ratio, and divider drag behaviour stay unchanged.
- Keyboard resizing for the separator is outside this change.

## Interaction

On devices with a fine pointer and hover support, the split-view pill is transparent while idle. It becomes visible when any of these conditions is true:

1. The pointer is over the existing 11px-wide, full-height divider target.
2. The pointer is over the pill itself.
3. Either chevron has keyboard focus.
4. The divider is being dragged.

The 11px divider target defines "near the edge". Moving from the divider onto the revealed pill must not hide it or start a resize drag.

The reveal uses a short opacity transition in the existing micro-feedback range. When the user prefers reduced motion, the transition is removed.

On devices without hover or with a coarse pointer, the pill remains visible. This avoids an undiscoverable touch target.

## Implementation

Keep the existing DOM and callbacks in `DraftDrawerControls`. Add split-only visibility rules to `src/theme.css`, scoped with `@media (hover: hover) and (pointer: fine)`.

Use `opacity`, rather than `display` or `visibility`, for the idle state. This keeps both buttons in the tab order. A `:focus-within` reveal makes the pill visible as soon as either button receives focus.

Use the existing sibling order in `App.tsx` to reveal the handle from divider hover:

```text
.elves-divider:hover ~ .elves-drawer-handle--split
```

The handle keeps its current higher stacking order, so its buttons remain clickable without triggering divider dragging.

## Accessibility

- Preserve the existing button names, titles, focus rings, and focus order.
- Reveal the pill with `:focus-within`; keyboard users must never focus an invisible control.
- Keep the control visible for touch and other coarse-pointer input.
- Respect `prefers-reduced-motion` by disabling the new opacity transition.

## Testing

Add Playwright coverage in `e2e/draft.spec.ts` for the browser-computed interaction:

1. In split view on a fine-pointer browser, the pill becomes transparent away from the divider.
2. Hovering the divider away from the pill's midpoint reveals the pill, proving the full divider is the trigger.
3. Moving onto a revealed chevron and clicking it changes the view without beginning a resize drag.
4. Focusing a chevron reveals the pill without pointer hover.

Keep the existing chevron round-trip and divider lifecycle tests as regression coverage. Run the focused end-to-end test, the relevant unit tests, typecheck, build, and the full test suite before opening the pull request.

## Success Criteria

- The split-view chevron pill is visually absent while the pointer is away from the canvas/draft edge.
- Hovering anywhere along the divider's 11px target reveals it.
- Pointer movement from divider to pill is stable and both actions still work.
- Keyboard focus and touch input always expose usable controls.
- Canvas-only and draft-only control visibility is unchanged.
