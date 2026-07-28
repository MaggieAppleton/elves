# Taller agent box

Date: 2026-07-28

## Problem

The in-app agent box (`/` on the canvas) shows only a sliver of the agent's
transcript. Two or three lines are visible at a time, so a run that reads cards
and streams a reply is unreadable — you watch text scroll past a letterbox.

The panel's outer shell already permits `max-height: calc(100dvh - 32px)`, but
`.elves-agentbox__transcript` carries its own `max-height: min(42dvh, 500px)`.
The transcript is the only flexible child, so that inner cap — not the shell —
decides the panel's height. The shell's allowance is dead code.

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

### `.elves-agentbox`

`max-height` becomes `calc(100dvh - 72px)` (with a `100vh` fallback line above
it, matching the existing pattern). The panel sits at `bottom: 24px`, so this
leaves a 48px gap above it — enough canvas visible at the top of the window to
stay oriented in the document. The previous `32px` total inset was smaller than
the bottom offset alone, so the panel could overshoot the top edge.

### `.elves-agentbox__transcript`

- `flex: 1 1 96px` becomes `flex: 0 1 auto`. The shell is content-sized (it sets
  no `height`), so there is never free space for `flex-grow` to distribute — the
  grow factor was already inert. `auto` basis states the real intent: take your
  content's height.
- `min-height: min(48px, 22dvh)` becomes `min-height: 0`. A flex child will not
  shrink below its content size without this. It is what lets the transcript
  scroll when the panel reaches its cap, instead of pushing the input row off
  the bottom of the screen.
- `max-height: min(42dvh, 500px)` is deleted. This is the cap causing the
  problem.

### `.elves-agentbox__input`

The `max-height: clamp(36px, calc(100dvh - 145px), 140px)` cap is unchanged, but
its comment is. It currently claims the `145px` reserves room for "the header,
row padding, panel inset, and a readable transcript". Once the transcript can
shrink to zero, no transcript reservation exists. The comment is corrected to
describe what the number actually protects: the header and row chrome on very
short viewports.

## Behaviour

| Transcript | Panel |
|---|---|
| Empty | Header + input row only, as today (the transcript element is not rendered until `hasTranscript`). |
| Two or three lines | Compact, as today. |
| Long | Grows upward from the bottom anchor until 48px from the top of the window, then the transcript scrolls with the header pinned above and the input row pinned below. |

The auto-scroll effect in `AgentBox.tsx:139` keeps the newest line in view and
needs no change. The rise-in animation, the collapsed pill, and the
`prefers-reduced-motion` block are untouched.

## Risks

Both `min-height: 0` and the deleted `max-height` remove floors that kept the
transcript visible on very short viewports. On a window under roughly 200px tall
the transcript can squeeze to nothing while the header and input row remain
usable. This is the correct trade — an unusable input row is worse than an
invisible transcript — and the viewport in question is pathological.

## Testing

Add a case to `e2e/agent-box.spec.ts`: stream a transcript long enough to exceed
the old ceiling, then assert the transcript's rendered height is greater than
500px and that the input row is still within the viewport. The height assertion
guards against reintroducing an inner cap; the input-row assertion guards
against the panel growing past its shell and clipping its own controls.
