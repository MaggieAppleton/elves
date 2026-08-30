# Canvas annotations and agent workbench — design

**Status:** approved direction; pending written-spec review

## Goal

Make agent feedback legible across canvas zoom levels and give it one calm,
inspectable home. Make the in-app agent feel like a focused canvas tool rather
than an empty floating chat window. Agents remain the sole authors of comments
and feedback; people can inspect, resolve and restore them, but never reply to
or edit their text.

## Annotation system

### One vocabulary, two placements

Attached comments and floating feedback are both **annotations**. They share:

- agent/reviewer provenance, optional feedback type and resolved state;
- one concise overview label (model summary when valid, otherwise a mechanical
  gist);
- a selected/open state; and
- a resolve action which sends the item to recoverable history.

Their placement remains meaningful: an attached annotation is anchored to a
card; a floating annotation is anchored to a canvas point. This does **not**
change the persisted data model or permit human authoring.

### Marker contract

At normal zoom, an attached card renders **one compact annotation row** along
its lower edge: the first unresolved type, a mechanically bounded gist and a
`+n` count where more than one annotation is open. It is the entire attached
annotation footprint; individual full bodies no longer stack below the card.
A floating feedback item renders the same compact marker at its canvas point,
rather than a separate text card. At overview zoom (the existing gist
threshold), both reduce to a counter-scaled type-and-count marker; the gist is
omitted rather than becoming tiny text. Every marker has an accessible label
naming its target, author and open count.

Selecting an attached marker opens the annotation right rail with its card's
open annotations listed in creation order and the first one selected. Selecting
a floating marker opens that annotation directly. The canvas never expands a
hidden body over neighbouring shapes. The attached row has a fixed, bounded
layout footprint, so the existing layout-obstacle calculation remains valid
without reserving variable comment-body height.

### Right rail

The annotation rail occupies the right edge at a stable reading width. It is a
detail surface, not a second canvas:

- heading: annotation type, agent/reviewer and target context;
- immutable full annotation body;
- resolve button; and
- an explicit close button returning to the previous canvas/draft view.

For an attached target, the rail also contains its compact list of open
annotations, so changing which comment is selected does not move the canvas.
Only one rail is open at a time. Opening it records the prior `Canvas · Split ·
Draft` view and restores that view on close. The rail replaces the draft reading
area for that moment rather than resizing the canvas coordinate system or
floating above cards. It does not include a comment input, reply affordance,
reactions, editing or deletion.

Resolved annotations leave the active canvas and appear in the existing
bottom-right review-home history. History opens an item in the same rail, with
its original target/position and a restore action.

## Agent workbench

### Idle composer

`/` still opens only outside editable content. The initial surface is a compact
bottom-centre command dock, not a blank chat panel. It contains:

- agent identity and unambiguous scope (`1 selected` or `Whole canvas`);
- a short contextual label when selection is present; and
- three small suggested task buttons appropriate to the scope (for example
  *Critique selection*, *Find evidence*, *Review structure*), which insert a
  prompt without auto-running it.

The typed prompt remains the primary action. Suggestions are accelerators, not
new agent capabilities.

### Active run and transcript

Submitting a task shows the user message, friendly tool activity and final
response as today. The first-class running state is the existing non-blocking
status pill: it states the current verb and scoped detail, remains in the
bottom-centre dock, and expands to the transcript on click. The expanded
transcript uses clear event hierarchy (request, agent response, muted tool
events, result/error) and preserves all current cancellation, Escape and
reduced-motion semantics.

The agent transcript is deliberately separate from the annotation rail. Agent
activity is temporal; annotations are persistent editorial objects.

## Boundaries and invariants

- No human replies or edits to attached comments/floating feedback.
- No new agent permission, tool or persistence protocol.
- `/` stays literal inside a card or text control; Escape never cancels a run.
- A collapsed agent run leaves the canvas usable.
- Overview annotation rendering must not block unrelated cards or make text
  smaller than its readable on-screen target.
- Existing agent, review and comment accessibility labels remain unique and
  descriptive.

## PR slices

1. **Annotation presentation contract.** Introduce pure shared helpers for
   annotation gist/marker state and add unit tests for zoom, summary fallback
   and resolved-state decisions. No rail or visual redesign yet.
2. **Overview markers.** Apply the contract to attached comments and floating
   feedback; preserve layout clearance and add E2E coverage at 100% and 50%.
3. **Annotation right rail + history.** Add one selected-annotation controller,
   right-rail surface, resolve/restore navigation and tests for view restoration.
4. **Agent command dock.** Redesign the idle `/` composer with scope context and
   prompt-inserting suggestions, retaining its keyboard contract.
5. **Agent activity hierarchy.** Polish expanded transcript and collapsed status
   states with the same behaviour and coverage as the existing agent box.

Each slice is independently mergeable. Slices 1–3 should land in order; slices
4–5 can proceed after their shared visual tokens are agreed, without touching
the annotation controller.

## Validation

- Unit: marker-state/gist fallback, resolved history and right-rail view-state
  transitions.
- E2E: attached and floating annotations at 100% and 50%; markers open the
  correct rail; resolved item restores; `/` focus exclusions; idle suggestions
  only fill prompts; status-pill collapse/expand/cancel behaviour.
- Manual: 1280 × 720 canvas capture before and after each visual slice, with
  one attached and one floating annotation visible.
