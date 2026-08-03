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

`max-height` stays at `calc(100dvh - 32px)`, and a `@media (min-height: 400px)`
block relaxes it to `calc(100dvh - 72px)`. Both keep the `100vh` fallback line
above the `dvh` one, matching the existing pattern.

The box sits at `bottom: 24px`, so the roomy case leaves a 48px strip of canvas
visible above a full-height box — enough to stay oriented in the document, and in
practice it clears the canvas toolbar.

The threshold exists because the extra inset is not affordable on a short window.
The header and input row have `flex-shrink: 0` and the transcript stops at its
own floor, so once `header + transcript floor + input row` exceeds the cap the
surplus is cut off by the box's `overflow: hidden` — the send button goes first.
Worst-case chrome is about 251px: a 43px header, the transcript's 48px floor,
20px of row padding, and a textarea at the 140px ceiling of
`clamp(36px, calc(100dvh - 145px), 140px)`. At `100dvh - 72px` that needs a 323px
window, so a 400px threshold clears it with room to spare, and below it the box
behaves exactly as it does today.

An earlier draft of this design used `max(188px, calc(100dvh - 72px))` instead.
That is wrong, and instructively so. The 188px was fitted to the 220px viewport
the test suite happened to exercise, but the textarea's own cap *grows* with the
window, so the squeeze is worst in the middle of the range rather than at its
short end. It clipped the send button by up to 29px between roughly 230px and
320px tall — a band no test covered.

### `.elves-agentbox__input`

The `max-height: clamp(36px, calc(100dvh - 145px), 140px)` cap is unchanged, but
its comment is sharpened to say what the reservation protects: a long draft must
never grow the input past the box and clip its own controls.

## Behaviour

| Transcript | Panel |
|---|---|
| Empty | Header + input row only, as today (the transcript element is not rendered until `hasTranscript`). |
| Two or three lines | Compact — about 205px on an 850px window. |
| Long | Grows upward from the bottom anchor until 48px from the top of the window (778px on an 850px window, against 96px before), then the transcript scrolls with the header pinned above and the input row pinned below. |

The auto-scroll effect in `AgentBox.tsx:139` keeps the newest line in view and
needs no change. The rise-in animation, the collapsed pill, and the
`prefers-reduced-motion` block are untouched.

## Risks

Nothing transitions the box's height, so during a long stream it now steps upward
a line at a time where it previously sat still. Left alone for now: animating
height is its own decision, and the jump is only visible while an agent is
actively writing.

## Testing

Two halves, in `e2e/agent-box.spec.ts`.

A tall-viewport case streams 25 paragraphs into a 900px-tall window and asserts
the transcript exceeds 500px (it measures 96px before the change, so this fails
hard on `main`), that the box stays on screen with a strip of canvas above it,
and that the transcript overflows into a scroller pinned to its newest line.

The existing short-viewport case is generalised from a single 220px height into a
sweep over 220, 260, 300, 340 and 420px, each with a ten-line draft in the input.
The single height was the problem: 220px is the one short height the discarded
`max(188px, …)` cap survived, so it passed while 260px and 300px clipped. The
sweep fails on both under that cap and passes under the media query.
