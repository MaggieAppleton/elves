# Taller agent box

Date: 2026-07-28

## Problem

The in-app agent box (`/` on the canvas) shows only a sliver of the agent's
transcript. Two or three lines are visible at a time, so a run that reads cards
and streams a reply is unreadable — you watch text scroll past a letterbox.

The cause is `.elves-agentbox__transcript`'s `flex: 1 1 96px`. The shell sets no
`height`, only `max-height`, so it is content-sized and there is never free space
for `flex-grow: 1` to distribute. The 96px flex-basis is therefore the transcript's
used height on every screen, whether the browser is 600px tall or 1400px.

Measured on a 900px-tall viewport, the transcript renders at exactly 96px. The
transcript's other cap, `max-height: min(42dvh, 500px)`, never engages — at that
viewport it would allow 378px. Both it and the shell's `max-height` are dead
code today.

## Goal

The box grows with its content until it nearly fills the browser, then scrolls
internally. A short chat stays as compact as it is today.

## Non-goals

Width stays at 560px. The panel stays anchored bottom-middle over the canvas.
No drag-to-resize, no docking to a screen edge, no persisted height.

## Design

Make the shell's `max-height` the single source of truth for the panel's height,
and let the transcript hug its content beneath it.

All changes are in `src/components/agentBox.css`.

### `.elves-agentbox__transcript`

- `flex: 1 1 96px` becomes `flex: 0 1 auto`. This is the fix. An `auto` basis
  states the real intent — take your content's height — and lets the box grow
  with the conversation. `flex-shrink: 1` is retained: it is what turns the
  transcript into a scroller once the box reaches its cap, rather than pushing
  the input row off the bottom of the screen.
- `max-height: min(42dvh, 500px)` is deleted. It would now bind, at 42% of the
  window, and it is the box's own `max-height` that should govern.
- `min-height: min(48px, 22dvh)` is **kept**. It guarantees a short viewport
  still shows some of the reply, and it already scales away on viewports too
  short to honour it.

### `.elves-agentbox`

`max-height` becomes `max(188px, calc(100dvh - 72px))` (with a `100vh` fallback
line above it, matching the existing pattern).

The panel sits at `bottom: 24px`, so the `calc` leaves a 48px strip of canvas
visible above a full-height box — enough to stay oriented in the document, and
in practice it clears the canvas toolbar.

The `188px` floor is load-bearing, and the first draft of this design omitted it.
The box needs roughly 185px to lay out its own chrome: a 42px header, the
transcript's 48px floor, and an input row grown to its cap (20px padding plus a
75px textarea at that viewport). On a 220px-tall window, `100dvh - 72px` yields
148px, and the box clips its own input row by 39px. Taking the larger of the two
means a viewport too short for both gives up the canvas strip rather than the
controls. `188px` is what the current `calc(100dvh - 32px)` already resolves to
at that viewport, so short-viewport behaviour is unchanged.

### `.elves-agentbox__input`

The `max-height: clamp(36px, calc(100dvh - 145px), 140px)` cap is unchanged, but
its comment is sharpened to say what the reservation protects: a long draft must
never grow the input past the box and clip its own controls.

## Behaviour

| Transcript | Panel |
|---|---|
| Empty | Header + input row only, as today (the transcript element is not rendered until `hasTranscript`). |
| Two or three lines | Compact — about 340px on an 850px window. |
| Long | Grows upward from the bottom anchor until 48px from the top of the window (778px on an 850px window, against 96px before), then the transcript scrolls with the header pinned above and the input row pinned below. |

The auto-scroll effect in `AgentBox.tsx:139` keeps the newest line in view and
needs no change. The rise-in animation, the collapsed pill, and the
`prefers-reduced-motion` block are untouched.

## Risks

The `188px` floor can exceed the window on a viewport shorter than about 212px,
where the box would overflow the top edge. That is the same trade the current
code makes and no worse than it; the viewport is pathological.

## Testing

Add a case to `e2e/agent-box.spec.ts` that streams 25 paragraphs into a 900px-tall
viewport and asserts:

- the transcript exceeds 500px, guarding against a reintroduced inner cap;
- the box stays on screen top and bottom, and the input row is inside it,
  guarding against the box growing past its shell and clipping its controls;
- the transcript's `scrollHeight` exceeds its `clientHeight` and it is scrolled
  to the bottom, guarding the overflow-and-follow behaviour.

The existing short-viewport case at 220px is the counterweight, and is what
caught the missing floor.
