# Agent authorship marks on note cards

**Date:** 2026-07-03
**Status:** Design approved, pending spec review

## Problem

When Claude writes a note card via the MCP, there is no visible signal that the
card came from an agent rather than the user. Maggie wants an at-a-glance mark —
a small Claude logo in orange, tucked in the top-left just to the right of the
`NOTE` label — so agent-authored notes are obvious.

The system must be **extensible to future agents** (OpenAI models, open-source
models). Today only Claude is wired up, but the design should let another agent
plug in its own logo and accent color without reworking the model. For now we
ship Claude only.

## Scope

- **In scope:** text note cards (`kind === 'note'`, `noteKind === 'text'`) created
  by an agent through the MCP. The mark renders inline beside the `NOTE` label.
- **Out of scope (for now):** reference cards (own face, no `NOTE` label) and
  image cards (edge-to-edge, no label). The model still records the author on
  every agent-created card, so surfacing the mark on those faces later is additive.
- **Mark content:** logo only (no agent name text) — quiet and minimal.

## Existing patterns this builds on

- **`authoredBy` is already a modeled concept.** `SectionProps` carries
  `authoredBy: 'user' | 'claude'`; `section.css` colors
  `[data-authored-by="claude"]` with `--elves-claude-accent` (a warm orange,
  `oklch(0.62 0.17 45)`, already defined in `theme.css` "for Claude authorship").
  This feature extends the same idea to note cards.
- **Attribution rides on the changeset.** Every MCP write is a `ChangeSet` with
  an `author` field (currently the hardcoded literal `'claude'`). Widening that
  to a string agent id carries the author in on the envelope that already exists.
- **tldraw shapes need a migration per new prop.** `CardShapeUtil` has a
  versioned migration sequence; a new field means one more `up`/`down` step.
- **One op, two apply paths.** `create_note_card` is applied in
  `src/apply/applyChangeSet.ts` (live tldraw editor) *and*
  `server/applyChangeSet.ts` (canvas.json on disk). Both must stamp the author,
  or a reload forgets it.

## Design

### 1. Data model — `authoredBy` on cards

Add to `CardProps` (`src/model/types.ts`):

```ts
/** Agent that authored this card via the MCP; null = human-authored.
 *  A string agent id (e.g. 'claude'), open-ended so new agents need no schema
 *  change — the agent registry maps a known id to its display metadata. */
authoredBy: string | null
```

- **Type is `string | null`, not an enum.** An open string is what makes the
  model extensible to future agents without a migration each time. Unknown ids
  simply render no mark (the registry returns null).
- **tldraw validator:** `authoredBy: T.nullable(T.string)` in `CardShapeUtil.props`.
- **Migration:** add `AddAuthoredBy` to `cardVersions`/`cardMigrations`.
  `up` sets `props.authoredBy = null`; `down` deletes it. (Mirrors `addAssetIdUp`,
  `addReferenceUp`, etc.)
- **Factories (`src/model/cards.ts`):** every factory sets `authoredBy`.
  `makeNoteCardProps(text = '', origin = 'typed', authoredBy: string | null = null)`.
  `makeProseCardProps`, `makeImageNoteCardProps`, `makeReferenceCardProps` set
  `authoredBy: null` (a shared `NO_AUTHOR`-style default keeps factories honest,
  like the existing `NO_SUMMARY`).

### 2. Attribution flow — widen `ChangeSet.author` to a string

In `src/model/changeset.ts`:

- `ChangeSet.author: 'claude'` → `author: string` (an agent id).
- `isChangeSet`: `cs.author === 'claude'` → `typeof cs.author === 'string'`.
- No new op field. `create_note_card` stays `{ text, x, y }`; the author comes
  from the enclosing changeset.

Both apply paths read `cs.author` and pass it into the factory:

- `src/apply/applyChangeSet.ts`: `applyCreateNoteCard` takes the author (thread
  `cs.author` from `applyChangeSet` → `applyOp` → `applyCreateNoteCard`) and calls
  `makeNoteCardProps(op.text, 'transcribed', cs.author)`.
- `server/applyChangeSet.ts`: the `create_note_card` case calls
  `makeNoteCardProps(op.text, 'transcribed', cs.author)`.

Only `create_note_card` consumes the author for now. References and sections are
unchanged (references already track `fetchedBy`; sections already track
`authoredBy` as `'claude'`).

### 3. MCP — config-driven agent id

- `mcp/index.ts`: resolve the agent id once from the environment, same pattern as
  the existing `ELVES_URL`:
  ```ts
  const agentId = process.env.ELVES_AGENT ?? 'claude'
  ```
  Thread it into the tool functions (or a closure) so every changeset is stamped
  with it.
- `mcp/tools.ts`: `makeChangeSet(ops, author = 'claude')` uses the passed id.
  All the `*Tool` functions that post a changeset take/forward the agent id.
- **Extending later:** point another agent's MCP server at `ELVES_AGENT=openai`.
  No tool-call changes; no per-call parameter.

### 4. Agent registry — `src/shapes/agents.tsx` (new)

The single extension point for adding an agent. It lives in the shapes/UI layer
(not `src/model`) because it holds a React logo component — keeping `src/model`
JSX-free. The `authoredBy` *field and type* stay in the model; only the *display*
registry lives here.

```ts
import type { FC, SVGProps } from 'react'

export interface AgentInfo {
  id: string
  name: string
  /** CSS color (a theme token) for this agent's mark. */
  accent: string
  /** Single-color logomark; renders with fill="currentColor". */
  Logo: FC<SVGProps<SVGSVGElement>>
}

export const AGENTS: Record<string, AgentInfo> = {
  claude: { id: 'claude', name: 'Claude', accent: 'var(--elves-claude-accent)', Logo: ClaudeLogo },
}

/** Look up an agent's display info; null for a human author or an unknown id. */
export function agentInfo(id: string | null): AgentInfo | null {
  return id ? AGENTS[id] ?? null : null
}
```

- Adding an agent = one entry: its id, name, accent color, and logo component.
- Unknown id or `null` → `agentInfo` returns null → no mark rendered (graceful,
  never throws, never shows a broken glyph).

The Claude logo component lives beside the registry in `src/shapes/agents.tsx`
(or a sibling file it imports), so the whole display concern — registry, accent,
logo — sits in one place in the UI layer.

### 5. Rendering — the mark beside the NOTE label

In `CardShapeUtil.tsx`, at the `NOTE` badge (currently a bare
`<span className="elves-badge">Note</span>`, shown when `!showGist && kind === 'note'`):

```tsx
{!showGist && kind === 'note' && (
  <div className="elves-badge-row">
    <span className="elves-badge" data-testid="card-badge">Note</span>
    {(() => {
      const agent = agentInfo(shape.props.authoredBy)
      return agent ? (
        <span
          className="elves-agent-mark"
          data-testid="card-agent-mark"
          data-agent={agent.id}
          title={`Written by ${agent.name}`}
          style={{ color: agent.accent }}
        >
          <agent.Logo aria-hidden="true" />
        </span>
      ) : null
    })()}
  </div>
)}
```

- Rendered only for text note cards, not gist mode, not while editing.
- `title` gives a hover tooltip ("Written by Claude") for discoverability and a11y.
- The mark inherits its color from `agent.accent`; the logo uses
  `fill="currentColor"` so a single component works for any accent.

`card.css` additions:

```css
/* NOTE label + agent mark share a top-left row. */
.elves-badge-row { display: flex; align-items: center; gap: 5px; align-self: flex-start; margin: -4px 0 0 -2px; }
.elves-badge-row .elves-badge { margin: 0; } /* row owns the tuck now */

/* Agent authorship mark — a small logomark a touch taller than the NOTE cap. */
.elves-agent-mark { display: inline-flex; }
.elves-agent-mark svg { width: 13px; height: 13px; display: block; }
```

- Height ~13px sits a little above the 10px small-caps label cap-height —
  "a little taller than the label but not by much," as requested.
- Same top-left tuck and accent language already used for Claude-authored sections,
  so it reads as part of the existing visual system.

### 6. The Claude logo asset

Source the official Claude logomark (the multi-spoke starburst / "sparkle") as a
single-path inline SVG React component with `fill="currentColor"`, `viewBox` set
so it scales cleanly at 13px. No name text, no background. Fetched/verified
against the official mark during implementation.

## Testing

- `makeNoteCardProps` stamps a passed `authoredBy`; defaults to `null`. Other
  factories default `authoredBy` to `null`.
- `AddAuthoredBy` migration `up` sets `null` on a pre-field card; `down` removes it.
- `isChangeSet` accepts any string `author`, still rejects a non-string/missing author.
- `agentInfo('claude')` returns the Claude entry; `agentInfo('nope')` and
  `agentInfo(null)` return `null`.
- Both apply paths stamp `cs.author` onto a created note card:
  - `src/apply/applyChangeSet.ts` via editor (unit or existing test harness).
  - `server/applyChangeSet.ts` via `applyChangeSetToSnapshot` (the created card's
    `props.authoredBy === cs.author`).
- (Optional) e2e/playwright: a note card created by `create_note_card` shows
  `[data-testid="card-agent-mark"]`.

## Files touched

| File | Change |
|---|---|
| `src/model/types.ts` | add `authoredBy: string \| null` to `CardProps` + doc |
| `src/model/cards.ts` | factories set/accept `authoredBy` |
| `src/shapes/agents.tsx` (new) | agent registry, `agentInfo()`, Claude logomark |
| `src/shapes/CardShapeUtil.tsx` | prop, validator, `AddAuthoredBy` migration, render mark |
| `src/shapes/card.css` | `.elves-badge-row`, `.elves-agent-mark` |
| `src/model/changeset.ts` | widen `author` to `string`; update `isChangeSet` |
| `src/apply/applyChangeSet.ts` | thread `cs.author` → `makeNoteCardProps` |
| `server/applyChangeSet.ts` | stamp `cs.author` on `create_note_card` |
| `mcp/index.ts` | read `ELVES_AGENT`; thread agent id |
| `mcp/tools.ts` | `makeChangeSet(ops, author)`; forward agent id |
| tests | as listed above |

## Non-goals

- No per-tool-call agent parameter (config-driven identity was chosen instead).
- No mark on reference or image cards yet (model records the author regardless).
- No agent name text in the mark (logo only).
- No change to the "Claude never writes prose" boundary — this is display + a new
  optional field, nothing about it relaxes `changeSetWritesText`.
