# Annotation Thread Reply Composer Design

## Goal

Make replies a deliberate, low-footprint action in every live `AnnotationThread`, while preserving a comfortable editor when a person chooses to respond.

## Scope

This changes the shared open-mode `AnnotationThread` used by canvas annotation popovers and the comment-states gallery. Preview threads remain read-only and continue to render no controls.

## Interaction design

- An open thread with `onReply` initially renders a compact, icon-only Reply button aligned to the component's lower right. It uses a labelled Phosphor reply-arrow icon and the established compact secondary-control styling.
- Selecting Reply replaces that trigger with the composer and moves focus into the textarea. Opening the composer never sends a reply or changes thread state outside the component.
- Once opened, the composer stays open until the thread is closed or a successful send clears its draft. This avoids hiding an in-progress response behind another action.
- The textarea grows to its content height as the user types. A deliberate vertical resize establishes a per-open-composer minimum height; further typing may grow it beyond that minimum, but never shrinks it below the user-selected height. Clearing or sending a reply resets that manual minimum for the next composer session.
- A small vertical resize grip sits at the composer's bottom-right outer corner. It does not occupy the text-entry area or overlap the send control. Pointer dragging adjusts the minimum height; keyboard users can adjust the focused grip with Up and Down arrows.
- The circular Phosphor send button stays inside the textarea at an exact 8px inset from the right and bottom edges. Its reserved text padding prevents text from sitting underneath it.

## Component structure

`AnnotationThread` owns `composerOpen`, the reply draft, the textarea ref, and its manual minimum height. It renders one of two mutually exclusive lower-right controls: the Reply trigger or the reply form.

The form contains the autosizing textarea, send button, and resize grip. The grip updates only this instance's minimum height, so simultaneous foreground threads remain isolated. Existing disabled/running behavior remains: the trigger and composer controls are disabled when canvas mutations are locked or the thread is replying; resolve and retry retain their current independent behavior.

## Styling and accessibility

The composer remains a design-system surface with its current focus ring, compact geometry, and Phosphor-only icons. Native `resize` is disabled so its browser-specific corner affordance cannot collide with send; the explicit grip supplies a consistent visual and interaction model instead.

Reply, send, and grip receive clear accessible names. The grip is keyboard focusable and exposes vertical separator semantics. The send control remains disabled for blank, locked, or running drafts. The textarea gets focus only after an intentional Reply activation.

## Verification

Component tests cover collapsed default state, composer opening/focus intent, isolated drafts, send/reset behavior, disabled/running controls, and the resize-minimum contract. CSS contract tests verify the 8px send inset, reserved text padding, disabled native resize, and visible resize-grip styling. The full Vitest suite and TypeScript checks must pass before creating the stacked PR.
