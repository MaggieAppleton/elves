# Delete a merged card — design

## Problem

When a note card has other cards merged **under** it, the only way a user sees
those hidden members is the fan-out peek opened from the `⊕ N merged` badge.
There is currently no way for a user to delete one of those merged cards. The
only merge-related operations that exist are agent-driven (`merge_notes` MCP
tool); there is no unmerge and no user-facing delete for merged members.

## Goal

Let the user permanently delete an individual merged (under) card directly from
the fan-out peek. The representative/top card and any other merged members stay.

## Non-goals (YAGNI)

- No unmerge / split-back-out (clearing `mergedInto` to `null`).
- No bulk "delete all merged" action.
- No confirmation dialog — tldraw undo (Cmd+Z) is the safety net.
- No agent-facing MCP tool or ChangeSet op.

## How merging works (context)

- A merged card carries `props.mergedInto = <representativeId>`
  (`src/model/types.ts:111`). Membership is derived, not stored on the rep:
  `mergedMembers(shapes, repId)` in `src/shapes/mergeView.ts:42` scans for cards
  whose `mergedInto === repId`.
- Merged cards are hidden from the canvas via `cardIsHidden` +
  `getShapeVisibility` (`App.tsx:52`). They are surfaced only through the
  read-only fan-out peek rendered in `CardShapeUtil.tsx` (~line 721), each member
  as an `elves-merge-fan__card` (~line 728).
- The `⊕ N merged` badge count and the fan-out are both derived from
  `mergedMembers`, so removing a member updates them automatically; deleting the
  last member makes the badge and fan-out disappear on their own.

## Approach

Client-only, mirroring the existing `convert-to-prose` and `comment-resolve`
buttons that mutate the tldraw store directly:

1. In `CardShapeUtil.tsx`, add a small **trash-icon button** to the corner of
   each fanned-out member card (`elves-merge-fan__card`), shown on hover of that
   card.
2. On click: `stopEventPropagation` (so it doesn't select/drag the canvas or
   toggle the peek), then `this.editor.deleteShape(memberId)`.
3. Give it `data-testid="delete-merged-card"`, `title`, and `aria-label`,
   matching existing card-button conventions.
4. Add a small Phosphor `TrashIcon` SVG component locally (same pattern as
   `ArrowsLeftRightIcon` near `CardShapeUtil.tsx:282`), or reuse one if present.
5. Add hover-reveal styles in `src/shapes/card.css` alongside the existing
   `.elves-merge-fan__card` rules.

### Why client-only

User-source document store changes auto-persist: `App.tsx:600` listens with
`{ source: 'user', scope: 'document' }` → debounced `saveCanvas` (POST /canvas).
So `editor.deleteShape` sticks and syncs without a ChangeSet op. ChangeSet ops
are only needed for agent actions. This keeps the change to two files.

## Files touched

- `src/shapes/CardShapeUtil.tsx` — trash button in the fan-out member, delete
  handler, `TrashIcon`.
- `src/shapes/card.css` — hover-reveal styling for the button.

## Testing / verification

- Manual: with a project that has merged cards, open the peek, hover a merged
  card, click the trash icon → card is gone, badge count decrements, deleting
  the last one removes the badge; Cmd+Z restores it; reload confirms it persisted.
- If a fan-out / merge test already exists, extend it to cover the delete button
  removing a member.

## Edge cases

- Deleting the **last** merged member: badge + fan-out vanish (derived state).
- We delete a *member*, never the representative here, so no orphaned
  `mergedInto` pointers are created.
