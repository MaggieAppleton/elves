# Annotation Thread Error Callout Design

## Goal

Present failed annotation replies as a clear, compact red callout in every shared annotation thread.

## Scope

The existing open-mode alert remains in AnnotationThread, so canvas popovers and the comment-states gallery render the same failure state. The alert gains the already imported Phosphor Warning icon, a wrapping message area, and its existing Retry button aligned at the callout’s right edge.

## Layout and behaviour

The callout uses a pale red surface, red border, and red text. A left message wrapper contains the 16px Warning icon and error text; min-width zero and overflow-wrap anywhere make long or unbroken failures wrap without colliding with Retry. Retry is non-shrinking, aligned right, and retains its existing disabled/running guard and callback behaviour.

## Accessibility and verification

Keep role alert and mark the warning decorative. Component tests cover alert semantics, icon, error text, Retry position contract, and disabled/retry behavior. CSS tests cover flex layout, danger styling, wrapping, and non-shrinking right-aligned Retry. Run focused tests, typecheck, and the full suite before updating PR #160.
