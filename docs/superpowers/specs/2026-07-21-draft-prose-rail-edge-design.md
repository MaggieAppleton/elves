# Draft Prose Rail Edge Design

## Goal

Move the blue focus rail for a prose card from the reading column to the left edge of the linear draft pane. The rail remains exactly the active prose card's height.

## Design

Draft sections retain normal block flow so their existing vertical margins keep collapsing. Each prose row owns a full-width, three-column grid: two flexible gutters of at least `40px` around a centered reading track capped at `64ch`. The full-width row draws focus state at the pane edge, while its paragraph, edit control, and editor stay in the reading track. Headings and visual blocks use centered block wrappers at the same measure, preserving paragraph wrapping and vertical rhythm.

Reading and editing use the same geometry. A focused prose edit target draws the rail on its full-width row; the active textarea is wrapped by the same full-width state container and draws the rail there. The rail uses the existing focus-ring colour and two-pixel width.

## Testing

Extend the draft Playwright coverage to focus a prose row and enter edit mode in both split and full-draft views. For each state, compare the focus indicator's left edge and height with the draft pane and active prose card. Retain the existing component interaction tests and run the full unit suite, typecheck, production build, and focused draft end-to-end spec.

## Scope

This change does not alter draft compilation, prose editing behavior, keyboard order, content width, visual-card layout, or drawer behavior.
