# Threaded Annotation Pins Design

## Goal

Replace the current full-width canvas annotation markers with compact, Figma-like
type-coloured pins at every zoom level. Each annotation is independently
addressable and expands into the same Claude conversation thread on canvas or
in the inspector.

## Scope

This supersedes the prior agent-only-comment UI decision: a person can reply in
an annotation thread, and sending a reply immediately invokes Claude to answer
in that same thread. It does not change card, feedback, review-pass, or general
agent-composer behaviour outside annotation threads.

## Interaction design

### Pins

- Every unresolved attached comment has one independent pin, rather than a
  count or aggregate marker.
- Pins use a fixed 28px circular coloured glyph, with a small pointer/notch to
  read as a location pin. They remain that compact size at every zoom level.
- An attached card lays its pins vertically just beyond the right edge, with a
  fixed gap so pins never overlap. A free-floating feedback annotation uses the
  same pin at its own canvas coordinate.
- Comment types map to stable icon-and-colour tokens. Examples include evidence
  (source/quote), structure (branch), counterpoint (arrows), tighten (scissors),
  unclear (question), citation (link), figure (image), and freeform (message).
  The accessible name always includes the readable type label and comment text.

### Inspecting and acting

- Hovering a pin, or focusing it with the keyboard, opens a non-modal canvas
  popover adjacent to the pin. The popover displays the full thread, not a
  truncated preview.
- Clicking a pin opens the existing right annotation inspector to that exact
  thread. Hover/focus never changes the inspector state.
- The popover and right inspector render one shared `AnnotationThread` surface:
  initial Claude comment, chronological replies, resolve/dismiss action, reply
  input, running state, error/retry affordance, and full attribution.
- The inspector remains the systematic review path: it shows the selected
  thread and supports stepping through remaining open threads without losing
  the pre-inspector view state.
- Resolving/dismissing a thread removes its pin. Resolved threads remain
  recoverable through Review home, as today.

## Thread model and Claude run

- Persist an annotation thread as the existing initial annotation plus an
  ordered sequence of messages. Each message records its author (`user` or
  `claude`), text, and creation time; the initial agent comment remains
  backwards compatible with existing comments/feedback.
- Sending a non-empty reply appends the user message durably before the network
  request starts. The client sets a per-thread running state and invokes Claude
  with the card/feedback context, annotation type, and full thread history.
- Streamed Claude text is rendered in the active thread and commits as one
  Claude response when the run completes. A failure leaves the user's reply in
  place, exposes a thread-local error, and offers retry without duplicating the
  user message.
- A thread has at most one in-flight Claude reply. Dismiss and close remain
  available while it is running; any existing general canvas mutation lock is
  respected.

## Implementation slices

1. **Pin presentation and shared inspector/popover:** introduce type icon
   tokens, per-comment pin placement, hover/focus popover, and a shared
   read-only thread surface. Preserve current persisted data and direct
   resolution while the message model is introduced.
2. **Persisted threaded replies and Claude execution:** add message migration,
   thread-aware changeset/API operations, immediate per-thread Claude runs,
   streaming/retry UI, and end-to-end concurrency/recovery coverage.

## Acceptance criteria

- No annotation marker takes its card's full width at any zoom.
- Multiple comments on a card display as individually clickable, non-overlapping
  pins along its right edge.
- Pins expose icon, colour, readable accessible name, full-thread hover/focus
  popover, and click-to-open inspector behaviour.
- A reply sent in either expanded surface is persisted and immediately receives
  Claude's reply in the same thread.
- The same user reply is never duplicated after a failed/retried request.
- Existing canvas view restoration, Review-home recovery, `/` exclusions, and
  generic AgentBox run semantics remain intact.

## Testing

- Unit tests cover token mapping, deterministic pin placement, thread migration,
  message ordering, and one-in-flight reply state.
- Component tests cover the shared popover/inspector thread surface, keyboard
  focus, reply-send state, failure/retry, and no duplicate messages.
- Playwright coverage verifies zoom-independent compact pins, a multi-comment
  card, hover/focus full-thread display, click-to-inspector, reply-to-Claude
  streaming, and resolved-thread recovery.
