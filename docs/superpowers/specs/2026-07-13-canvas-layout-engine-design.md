# Canvas Layout Engine Design

## Problem

The canvas currently has several unrelated placement rules. Toolbar-created cards move 24 pixels diagonally, agent-created cards only avoid existing card bodies, questions land exactly where requested, and comments and merged-card peeks sit outside tldraw's recorded geometry. The result is tidy-looking coordinates with visibly overlapping UI.

Playwright research reproduced four failures:

- Three toolbar-created 370×114 cards were offset by 24 pixels but still overlapped.
- A 193-pixel comment stack crossed two cards that were otherwise 24 pixels apart.
- Two agent questions requested at the same point occupied the same 370×90 rectangle.
- A merged-card fan covered its neighbouring card; hit-testing the neighbour returned the fan.

## Goals

- Keep at least 24 pixels of visible space between canvas items created or moved by agents.
- Stack toolbar-created cards vertically with a 24-pixel gap.
- Count visible comments as part of a card's occupied footprint.
- Move downstream cards when comments are added, resolved, or change height.
- Place questions clear of cards, comments, and other questions.
- Open merged-card peeks in clear space without blocking another card.
- Use the same pure layout rules in the browser and server snapshot paths.
- Preserve x coordinates during automatic card placement so narrative section order does not change.

## Non-goals

- Human dragging remains freeform. The engine will not fight a deliberate manual overlap.
- The engine will not repack the entire canvas or remove intentional large areas of whitespace.
- Sections remain implicit x-coordinate bands; this work does not add section membership records.
- Existing canvases are repaired locally when an affected item changes, not globally on load.

## Behaviour

Automatic layout is local and downward-moving. A new or agent-moved item keeps its requested x coordinate. If its visible footprint is fewer than 24 pixels from an obstacle, it moves below the lowest collision and leaves exactly 24 pixels. The check repeats because clearing one item can reveal another lower down.

When a card's comment footprint grows, cards below it in the same horizontal lane move down just enough to restore the 24-pixel gap. When comments shrink or disappear, that local lane compacts upward. Cards outside the lane do not move.

Questions use the same obstacle set as cards. Merged-card peeks are temporary overlays, so they do not move persisted canvas items; they choose a clear slot around the representative card instead.

## Architecture

### Shared occupancy model

`src/model/layout.ts` becomes the pure source of layout truth. It owns:

- `CANVAS_GAP = 24`
- axis-aligned rectangle and layout-item types
- collision checks that include the required gap
- downward clear-slot placement
- local vertical lane reflow
- clear overlay-slot selection

The functions accept plain rectangles and return coordinates or moves. They do not depend on React, tldraw, the DOM, or server storage, so Vitest can exercise them directly and both runtime paths can use them.

### Card footprints

Card body height and comment extension remain separate. A migrated `commentH` card property stores the visible comment stack's extension below the body, including its top margin. The occupied rectangle is therefore `h + commentH`; the card's visual body and resize behaviour continue to use `h`.

The browser measures the real rendered comment stack with a resize observer, converts screen pixels to page units, and updates `commentH` only when it changes by more than one pixel. The server uses the last persisted measurement and a conservative text-based estimate immediately after adding a comment. The next browser measurement corrects the estimate and persists the exact footprint.

Hidden merged cards and dismissed questions never become obstacles. Grouped cards contribute page-space bounds; any automatic move is converted back into the shape's parent space.

### Mutation integration

The client and server change-set applicators build equivalent obstacle lists.

- Create card/reference/figure: find a clear position before insertion.
- Move cards: exclude the moving set from its old positions, then place each requested rectangle clear of remaining and already-moved items.
- Add comment: update the comment footprint and reflow the affected vertical lane.
- Create question: find a clear position among cards and visible questions.

Toolbar card creation uses the same client adapter instead of the diagonal cascade. Sections keep their existing cascade because section headers are labels rather than card obstacles.

### Merged-card peeks

The merged fan measures its rendered size when opened. It asks the shared overlay-slot helper to try right, left, below, and above the representative with a 24-pixel gutter. If those immediate slots are occupied, it scans downward from the right-hand position until clear. The chosen offset is ephemeral React state and never changes persisted card positions.

## Testing

Pure model tests cover gap-aware collision, repeated downward placement, local lane reflow, comment footprints, hidden items, and overlay-slot choice.

Server and client applicator tests prove equivalent outcomes for card creation, multi-card moves, comments, and questions. Tests are written first and observed failing before implementation.

Playwright tests recreate the researched failures and assert DOM rectangles rather than screenshots alone:

- toolbar-created cards have a 24-pixel vertical gap;
- comments leave 24 pixels before the next card;
- duplicate-position questions do not overlap;
- an expanded merged fan does not intersect or intercept its neighbour.

Before-and-after screenshots provide a visual check alongside the geometric assertions.

## PR slices

1. **Core placement:** shared geometry primitives, 24-pixel toolbar stacks, and collision-safe agent card creation/moves.
2. **Comment footprints:** persisted measured comment extension plus local downstream reflow.
3. **Questions and peeks:** collision-safe questions and adaptive merged-card fan placement.

Each PR is independently testable and will live on its own branch/worktree. The later PRs may be stacked on the earlier ones where they share the layout primitives.
