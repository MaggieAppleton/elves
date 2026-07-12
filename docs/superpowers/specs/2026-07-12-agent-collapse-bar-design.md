# Agent box collapse bar

## Problem

While the in-app agent (`AgentBox`) works the canvas, its floating box sits
bottom-middle and covers the work. The only way to get it out of the way is the
header **X**, which *looks* like it cancels the run — so the user avoids it and
keeps the box open. (In fact X only hides; the run survives. The Broom is the
one that cancels + clears. The problem is legibility, not behaviour.)

The user wants to **collapse the box down to a small status bar** that shows what
the agent is doing right now ("Reading · 3 cards", "Thinking…"), stays out of the
way on the canvas, and expands back to the full box on click.

## End state

- A **collapse chevron (▽)** replaces the header **X**. The Broom (🧹 cancel +
  clear) stays. So the header has two actions: collapse (safe) and Broom
  (destructive).
- Clicking ▽ shrinks the full box to a **collapsed bar** anchored in the same
  bottom-middle spot. The run and transcript are preserved (the component is
  already kept mounted).
- The collapsed bar shows: an animated working indicator + **verb + detail**
  status derived from the live event stream, e.g. `◐ Reading · 3 cards`,
  `◐ Searching · elves canvas`, `◐ Thinking…`.
- Clicking the bar **expands** back to the full box.
- **When the run finishes while collapsed**, the bar stays collapsed and switches
  to a `✓ Done — click to view` state with a gentle one-shot pulse so it's
  noticeable but not interruptive. An errored run shows an error state.
- **Esc / collapse is conditional**: if there's a run or transcript to preserve,
  it collapses to the bar; if the box is idle (nothing typed, nothing run), it
  fully closes (`onClose`) — an empty bar would be meaningless. This is the only
  change to existing dismiss behaviour.

## Architecture (approach B)

Keep collapsed/expanded **rendering and state inside `AgentBox.tsx`** (small,
shares state + CSS), but extract the one piece of real, opinionated logic — the
tool → verb mapping — into a **pure, testable module**.

### New: `src/client/agentStatus.ts`

```ts
export interface AgentStatus {
  phase: 'thinking' | 'working' | 'done' | 'error'
  verb: string          // "Reading", "Searching", "Thinking", "Done"…
  detail?: string       // reuses the tool event's existing `summary`
}

// Pure: no knowledge of the bar or React. (entries, running) → status.
export function deriveStatus(entries: StatusEntry[], running: boolean): AgentStatus
```

Rules:
- `running` + last entry is a `tool` → `{ phase:'working', verb: verbFor(name),
  detail: summary }`.
- `running` + last entry is anything else (user msg, agent prose, nothing yet) →
  `{ phase:'thinking', verb:'Thinking' }`.
- not running + last entry is `error` → `{ phase:'error', verb:'Error' }`.
- not running otherwise → `{ phase:'done', verb:'Done' }`.

`verbFor(toolName)` is a small lookup table mapping the app's MCP tools to
present-tense verbs (read\_\* → "Reading", create\_\* → "Writing", edit\_\* →
"Editing", move/group/merge → "Organising", \*review\* → "Reviewing",
tool search → "Searching", bash → "Running", fallback → the humanised tool name).
This table is the subjective, easy-to-retune part; it lives here so it's obvious
and unit-tested.

The `Entry` type currently lives in `AgentBox.tsx`. `deriveStatus` takes a
minimal structural `StatusEntry` shape (just the `kind` + `name` fields it
needs), exported from `agentStatus.ts`. `AgentBox`'s richer `Entry` is assignable
to it, so no type moves and there's no import cycle.

### Changed: `src/components/AgentBox.tsx`

- New local state `const [collapsed, setCollapsed] = useState(false)`.
- `hasContent = entries.length > 0 || running` (rename of existing
  `hasTranscript`).
- `handleCollapse()`: if `hasContent` → `setCollapsed(true)`; else `onClose()`.
- Esc handler calls `handleCollapse()` instead of `onClose()`.
- Header: replace the X button with a collapse-chevron button
  (`CaretDown` from phosphor) wired to `handleCollapse`. Keep the Broom.
- When `collapsed`, render a `<button className="elves-agentbox--collapsed">`
  instead of the full box. It shows the indicator + `deriveStatus(...)` text and
  calls `setCollapsed(false)` on click.
- Submitting a new prompt or the Broom clear should also `setCollapsed(false)` so
  the box returns to full view when re-engaged.
- On finish while collapsed: no special code needed — `deriveStatus` returns the
  `done`/`error` phase and the bar re-renders. The one-shot pulse is a CSS
  animation keyed on the phase (e.g. `data-phase="done"`).

### Changed: `src/components/agentBox.css`

- Styles for `.elves-agentbox--collapsed`: a compact pill at the same fixed
  bottom-middle anchor, animated working dot (reuse/adapt `elves-agentbox__dot`),
  verb + muted detail, hover affordance, and a `data-phase="done"` pulse
  keyframe. Respect `prefers-reduced-motion`.

## Isolation / testing

- **`deriveStatus`** is pure and has no React/DOM deps → straightforward unit
  tests (Vitest, matching the repo's test setup): each phase, the verb table, the
  detail passthrough, empty/first-tick cases.
- **Bar interaction** — an e2e/component test: run an agent (or stub events),
  click collapse, assert the bar shows status, click the bar, assert the full box
  returns. (Note: repo memory flags realtime push flakiness in the bg sandbox; a
  unit test of `deriveStatus` is the reliable core, e2e is best-effort.)

## Out of scope (YAGNI)

- Lifting collapse state to `App.tsx` — nothing else needs it.
- Dismiss-from-bar / per-agent status colours / multi-run history.
- Server changes — everything needed already flows to the client.
