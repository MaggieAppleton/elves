# Centre Toolbar-Created Cards in the Viewport

## Problem

The prose, note, and figure toolbar actions begin with the correct page-space viewport centre, then pass that position through `clearCardPosition`. If the centre overlaps a populated vertical lane, the collision scan repeatedly moves the new card down until it clears the entire lane. The card can therefore appear at the end of a section, outside the area the user is looking at.

This is a placement-policy problem, not a coordinate-conversion problem. `Editor.getViewportPageBounds()` already accounts for camera pan and zoom.

## Decision

Cards created directly from the toolbar will be centred exactly in the current viewport, even when that means overlapping an existing item. The new card is selected and enters editing immediately, so it remains visually and interactively foremost.

This matches the existing toolbar behaviour for image and reference cards.

## Scope

Change the direct human creation path for:

- prose cards;
- note cards;
- figure cards.

Keep collision-safe placement unchanged for agent and MCP change sets. Those paths receive explicit page coordinates and need deterministic spacing when no person is present to resolve an overlap.

Keep section placement unchanged. Section headers use their existing cascade because they label canvas regions rather than behaving like content cards.

## Implementation

`App.addCard` will use the top-left coordinate derived directly from the current viewport centre and the new card's dimensions. It will no longer call `clearCardPosition`.

The shared collision primitives in `src/model/layout.ts` and `src/client/canvasLayout.ts` remain intact for agent-created cards, questions, moves, and overlays.

## Testing

Replace the Playwright regression that requires toolbar cards to stack below one another. The new regression will:

1. create a toolbar card at the viewport centre;
2. leave it in place as an obstacle;
3. create another toolbar card;
4. assert that the new card's visual centre matches the visible tldraw canvas centre within rendering tolerance.

The test will exercise prose, note, and figure actions so the three toolbar entry points cannot drift apart. Existing model and change-set tests will continue to protect collision-safe agent placement.

Verification will include the focused Playwright card spec, the unit suite, type-checking, and a production build.

## Out of Scope

- Repacking or moving existing cards.
- Changing drag-and-drop coordinates.
- Changing asynchronous image or reference placement.
- Removing the shared 24-pixel collision rule from agent operations.
