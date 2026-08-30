# Annotation Canvas Threads

**Date:** 2026-08-30  
**Status:** Approved design, pending written-spec review  
**Supersedes:** The inspector-opening and resolved-stack interactions in `2026-08-29-threaded-annotation-pins-design.md`

## Goal

Make annotations readable at a glance and directly actionable on the canvas without displacing the canvas or permanently displaying archival information.

## Interaction model

Annotations have three presentation states:

1. **Resting:** only the compact annotation pin is visible.
2. **Hover or keyboard focus:** a temporary, read-only preview shows the full conversation. It contains no textarea, reply action, resolve action, or other interactive controls.
3. **Open:** clicking the pin opens an interactive thread anchored beside that annotation. It contains the full conversation, reply and retry behaviour, resolve controls, and an X to dismiss it.

Opening a thread is session-only UI state. Replies and resolution status continue to persist through the existing annotation data model, but open threads do not return after a page reload or project reopening.

More than one thread may be open at once. Each thread remains open through ordinary canvas interaction until its own X is clicked or the annotation is resolved. Clicking an already-open thread brings it above other open threads. The X closes only that presentation; it does not resolve the annotation or change its messages.

Resolving an annotation persists its resolved status, closes its open thread, and hides its pin. Resolved records remain in the underlying model, but this design provides no permanent canvas UI for browsing or reopening them.

## Placement and canvas behaviour

Open threads are anchored and non-draggable. They follow their annotation pins when the canvas pans or zooms and when the underlying shape moves.

Interactive threads render in a stage-level overlay above ordinary canvas shapes, link previews, feedback cards, and other non-active annotation content. This avoids the clipping and stacking contexts created by individual HTML shapes. The most recently engaged open thread is placed above other open threads.

Placement is viewport-aware. A thread prefers the normal position beside its pin, flips when there is insufficient room, and is clamped within the visible canvas stage when necessary. Moving an anchor out of the viewport does not detach the thread from it.

Hover previews use the same foreground layering guarantee but remain temporary and read-only. Moving from the preview into the pin or clicking the pin must not produce a flicker or expose reply controls before the click.

## State and data flow

Replace the single inspector-oriented annotation target with a session-only collection of open targets keyed by stable annotation identity. Opening adds or promotes a target; dismissing removes only that target. This collection is presentation state and is never serialised into a project.

Pin hover and keyboard-focus state remains local to the pin presentation. A click requests that the application add the target to the open collection. The stage-level overlay resolves each target to its current annotation content and canvas anchor, then renders the existing interactive thread presentation at the calculated stage position.

Existing reply streaming, retry, message persistence, and resolve paths remain authoritative. Each open thread displays its own reply state so simultaneous threads cannot overwrite or dismiss one another. A reply failure remains visible and recoverable in the affected thread only.

If an annotation target disappears because its shape is deleted, project state changes, or new annotation data no longer contains it, its open presentation is pruned safely without altering other targets.

## Removed interface and state

Remove both existing side-channel presentations:

- the right-side annotation inspector opened by clicking a pin;
- the permanently visible resolved-annotations stack and its canvas-edge handle.

Remove the inspector-specific forced split-view transition, previous-view restoration bookkeeping, obsolete drawer components and styles, resolved-stack derivation and rendering, and props that exist only to reopen an item from that stack.

Removing these interfaces must not delete resolved annotation records or disturb the normal review controls unrelated to the resolved stack.

## Accessibility and input

Pins remain keyboard focusable. Keyboard focus reveals the same read-only preview as hover. Activating a pin opens its interactive thread. The open thread has a labelled close button, sensible focus order, and does not close merely because focus moves elsewhere. Escape may close the currently focused thread only if that follows the application's established dismissible-surface convention; the visible X is always available.

Foreground layering must preserve pointer interaction with the textarea, reply, retry, resolve, and close controls. A non-interactive part of the overlay must not block panning or selection on the canvas beneath it.

## Verification

Component coverage must establish that:

- hover and focus previews show the complete conversation without interactive controls;
- clicked threads show reply, retry where applicable, resolve, and close controls;
- closing one of several targets leaves the others open;
- resolving closes only the resolved target;
- a fresh application session starts with no open targets;
- missing or deleted targets are pruned safely.

Browser coverage must exercise:

- the hover-to-click transition without flicker or premature controls;
- multiple simultaneously open threads and foreground promotion;
- reply streaming, failure, retry, and successful persistence;
- resolve, immediate close, and hidden pin behaviour;
- anchoring during pan, zoom, and underlying-shape movement;
- placement near each viewport edge;
- foreground stacking over cards, feedback shapes, link previews, and other annotations;
- absence of the annotation inspector, forced split-view change, resolved stack, and edge handle;
- reload clearing open presentation state while preserving messages and resolved records.

## Out of scope

- Persisting which threads are open across reloads.
- Dragging or manually positioning open threads.
- Reintroducing an archive or browser for resolved annotations.
- Changing the persisted annotation message or resolution schema.
