# Section headers — spec + implementation plan

- **Status:** Approved, implementing
- **Date:** 2026-07-02

## 1. Problem

When laying out an essay's argument left-to-right on the canvas, the writer needs
big thematic labels floating above clusters of cards ("Origins", "The turn",
"Counterarguments") so the shape of the piece reads at a glance when zoomed out
to ~25%. Claude needs to read, create, and reposition these labels as part of
helping organize the canvas — and, per this design, may also rename an existing
one. This is new: every other piece of text on the canvas (card prose, card
source text) is one participant's exclusively.

## 2. Design

### 2.1 Architecture: a new shape, not a third `CardKind`

`src/model/cards.ts`'s `claudeMayEditCardText()` hard-codes `false` — Claude
structurally cannot write Card text, and `changeSetWritesText()` in
`src/model/changeset.ts` defaults every *unrecognized* op to unsafe. That pair
of functions is the entire enforcement boundary for Elves' core rule. A section
label inverts the rule (both participants may write it), so it must not become
an exception carved into that boundary. It becomes its own model, shape, and
changeset ops instead — the Card boundary is untouched by this feature.

### 2.2 Data model — `src/model/sections.ts` (new)

```ts
export type SectionAuthor = 'user' | 'claude'   // author of the CURRENT text

export interface SectionProps {
  w: number
  h: number
  text: string
  authoredBy: SectionAuthor
}

export const SECTION_DEFAULT_W = 320
export const SECTION_DEFAULT_H = 72

export function makeSectionProps(text = '', authoredBy: SectionAuthor = 'user'): SectionProps
```

No `comments`, `origin`, `sourceKind`, or `mergedInto` — a section is a label
plus who last wrote it. `authoredBy` flips whenever the text changes, from
either side: the app's own editor always sets `'user'`; the two Claude ops that
touch text (`create_section`, `edit_section_text`) always set `'claude'`.

### 2.3 Shape — `src/shapes/SectionShapeUtil.tsx` (new)

- `type = 'section'`, registered alongside `CardShapeUtil` in `App.tsx`'s
  `shapeUtils` array.
- `props`: `w: T.number`, `h: T.number`, `text: T.string`,
  `authoredBy: T.literalEnum('user', 'claude')`.
- Renders bare text — no card box, border, background, or padding chrome, just
  the words sitting on the canvas. Bold, `var(--elves-card-font)`,
  `font-size: 56px`, tight line-height. At 0.25× zoom that's ~14px effective —
  legible, same order as normal body text.
- Color is the provenance signal: `var(--elves-ink)` when `authoredBy ===
  'user'`; a new token `var(--elves-claude-accent)` (warm orange, distinct from
  the muted comment-orange already used for `weak-argument`) when `'claude'`.
  No extra badge — color alone is the marker, per the answered design question.
- Click-to-edit reuses the Card pattern: `editor.getEditingShapeId() ===
  shape.id` renders a `<textarea>` instead of the text div; `onChange` calls
  `updateShape` with `{ text, authoredBy: 'user' }` together, so editing your
  own words always reclaims the ink color even if Claude wrote it last.
- `canResize()` → `true`, `onResize` → reuse tldraw's `resizeBox` (same as
  `CardShapeUtil`), so a long label can be widened to wrap instead of running
  on forever.
- `indicator()` → a plain `<rect>` matching `w`/`h` (no rounded corners needed
  since there's no visible box).
- No migrations needed — this is a shape type's first version.

### 2.4 Changeset ops — extend `src/model/changeset.ts`

```ts
export type Op =
  | ...existing...
  | { kind: 'create_section'; text: string; x: number; y: number }
  | { kind: 'move_sections'; moves: { sectionId: string; x: number; y: number }[] }
  | { kind: 'edit_section_text'; sectionId: string; text: string }
```

- `isOp()` gets three new cases mirroring `create_source_card`/`move_cards`.
- `changeSetWritesText()`: `create_section` and `move_sections` return `false`
  (same reasoning as their card equivalents). `edit_section_text` is the *one*
  deliberate exception — it returns `false` with a code comment explaining
  section labels are organizational, not prose, so this op is consciously
  exempted from the prose-write guard. Every other/unknown kind still defaults
  to unsafe.
- `referencedCardIds()` is unchanged (cards only). New
  `referencedSectionIds(cs)` collects `sectionId` from `move_sections` and
  `edit_section_text` (mirrors `referencedCardIds`; `create_section` mints a
  new id and references nothing, same as `create_source_card`).

### 2.5 Apply — `src/apply/applyChangeSet.ts`

- `applyCreateSection`: `editor.createShape({ id: createShapeId(), type:
  'section', x, y, props: makeSectionProps(op.text, 'claude') })`.
- `applyMoveSections`: for each move, `editor.getShape(sectionId)` then
  `editor.updateShape({ id, type: 'section', x, y })`.
- `applyEditSectionText`: `editor.getShape(sectionId)` then `updateShape({ id,
  type: 'section', props: { text: op.text, authoredBy: 'claude' } })`.
- Wired into the existing `applyOp` switch.

### 2.6 Server — `server/digest.ts`, `server/app.ts`

- New `SectionDigest { id, text, x, y, authoredBy }` and `snapshotToSections()`
  in `server/digest.ts`, filtering `r.type === 'section'` the same way
  `snapshotToCards` filters `r.type === 'card'`.
- `GET /projects/:id/cards` is replaced by `GET /projects/:id/canvas-digest` →
  `{ cards: CardDigest[], sections: SectionDigest[] }` (one call for Claude to
  reason over the whole canvas at once — sections are read alongside cards,
  not as an afterthought).
- The changeset route's cross-project-reference check extends: build a
  section-id set from `snapshotToSections`, and reject (409) if
  `referencedSectionIds` includes an id not in this project — same treatment
  cards already get.
- `changeSetWritesText` guard is unchanged code (already handles the new ops
  correctly per §2.4); the route just keeps calling it.

### 2.7 MCP tools — `mcp/elvesClient.ts`, `mcp/tools.ts`, `mcp/index.ts`

- `elvesClient.ts`: `readCards` → `readCanvasDigest`, hitting
  `/canvas-digest` and returning `{ cards, sections }`.
- `tools.ts`: `readCanvasTool` returns the combined digest. New
  `createSectionTool`, `moveSectionsTool`, `editSectionTextTool`, each posting
  the matching op via `makeChangeSet`.
- `index.ts` (MCP server registration): new tools —
  - `create_section(project, text, x, y)` — "Create a big thematic label over
    a cluster of cards. x is narrative order like cards; this is a section
    title, never prose."
  - `move_sections(project, moves)` — mirrors `move_cards`.
  - `edit_section_text(project, sectionId, text)` — "Rename an existing
    section label — tighten a label, merge two into one name. Section labels
    are organizational, not prose, so you may write this text directly. Never
    use this on a card."
  - `read_canvas` tool description updated: now returns `{ cards, sections }`;
    each section has `authoredBy` ('user' | 'claude') showing who wrote its
    current wording.

### 2.8 App.tsx (human path)

- Register `SectionShapeUtil` in `shapeUtils`.
- 4th toolbar button "+ Section" (same style as Prose/Notes/Image) — creates a
  section at the viewport center with `makeSectionProps('', 'user')`, selects
  it, and immediately enters edit mode (`editor.setEditingShape(id)`) so the
  writer can type the label right away.
- The app's own textarea `onChange` for a section always writes `authoredBy:
  'user'` alongside the new text.

### 2.9 Visual tokens — `src/theme.css`

New token: `--elves-claude-accent: oklch(0.62 0.17 45);` — a clear, warm
orange, more saturated than the muted `--elves-cc-weak-label` comment tone, so
"Claude wrote this" reads unambiguously against the cream background.

### 2.10 Skill doc — `skill/elves-canvas.md`

- "The canvas" section: add sections as a third kind of thing — a big heading
  label over a cluster, `x` is a narrative anchor like cards.
- Document `create_section`, `move_sections`, `edit_section_text`.
- Note `read_canvas` now returns `{ cards, sections }`.
- Explain the color rule: writing/renaming a section turns it orange
  (Claude-authored); the user's own edits turn it back to ink. Renaming a
  section is fine; renaming a *card's* text is never fine — the two must not
  be conflated.

## 3. Implementation plan

1. **Model + shape** (`src/model/sections.ts`, `src/shapes/SectionShapeUtil.tsx`,
   `src/shapes/section.css` or additions to `card.css`, `src/theme.css` token,
   `src/App.tsx` registration + toolbar button). Unit tests:
   `tests/model/sections.test.ts` (`makeSectionProps` defaults),
   `tests/shapes/...` if a shape-level test fits the existing pattern.
2. **Changeset ops** (`src/model/changeset.ts`, `src/apply/applyChangeSet.ts`).
   Extend `tests/model/changeset.test.ts` and `tests/model/guard.test.ts` with
   section cases (including the `edit_section_text` exemption from
   `changeSetWritesText`, mirroring the existing "Phase 2 ops" test).
3. **Server** (`server/digest.ts`, `server/app.ts`). Extend
   `tests/server/digest.test.ts` and `tests/server/changeset.test.ts` /
   `tests/server/api.test.ts` with section fixtures and the new
   `canvas-digest` route (replacing the old `/cards`-only assertions where
   they exist).
4. **MCP** (`mcp/elvesClient.ts`, `mcp/tools.ts`, `mcp/index.ts`). Extend
   `tests/mcp/tools.test.ts` and `tests/mcp/server.test.ts` with the three new
   tools and the combined `read_canvas` shape.
5. **Skill doc** (`skill/elves-canvas.md`).
6. **Verify**: `npm test`, `npm run typecheck`. Manually confirm in the app:
   create a section via the toolbar, edit its text, move it; post a
   `create_section`/`edit_section_text` change-set through the MCP tool path
   and confirm it renders orange and hot-reloads live.
7. **Ship**: commit, push branch, open a draft PR.

## 4. Out of scope (this pass)

- Comments on sections.
- Any grouping/frame relationship between a section and "its" cards — a
  section is a free-floating label positioned by geometry only, same as the
  user described ("loosely... roughly where each section is going").
- Multiple font sizes / heading levels for sections.
