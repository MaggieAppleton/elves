# Canvas-wide agent feedback and reviews

## Purpose

Make agent feedback a first-class canvas annotation system. A review personality is a constrained, named version of the same agent feedback workflow, rather than a separate feature with its own output model.

## Shared feedback primitive

An agent feedback annotation has immutable agent-authored content and provenance:

- agent identity;
- optional reviewer persona and review-run link;
- feedback type;
- resolved or dismissed state; and
- one of two placements: anchored to a card, or floating at a canvas position.

All agents can create either kind of feedback through the same MCP surface. Review personas use the same actions, with an additional brief, comment budget, and review lifecycle.

People may move every canvas object, including agent feedback. They cannot edit agent-authored feedback text. They can resolve or dismiss feedback.

## Placement

- Use an anchored comment when one card is the clear subject.
- Use a floating comment card when feedback concerns a cluster, relationship, gap, or other observation with no single target.
- Place floating feedback beside its relevant cluster.
- Place essay-wide feedback on the far-left global edge, just left of the uppermost left-hand card stack. Multiple global comments form a vertical stack there.

## Review behavior

Each reviewer reads the whole canvas, not only the compiled draft. Scope includes prose, notes, references, figures, and image cards using their existing text and metadata. Image labelling and vision-based interpretation are explicitly out of scope.

The existing reviewer personalities remain: Devil's Advocate, Fact-Checker, Trimmer, First Reader, and Architect. A review-created annotation shows both its agent identity and reviewer persona. A generic agent-created annotation shows its agent identity.

Review passes stay within their existing budgets and avoid regenerating feedback already resolved or dismissed. A failed pass remains retryable without duplicating feedback from an earlier attempt.

## Review home and resolved feedback

Move the review control from the top bar to the bottom-right of the canvas. This area is the review home for requesting a review, observing active passes, and accessing one resolved-feedback stack.

Resolving or dismissing a floating comment removes it from the active working canvas and adds it to that stack. The stack keeps each item's provenance visible: reviewer name when applicable, reviewer colour, agent identity, and feedback-type label. It is one shared stack rather than a separate stack per review run.

## Validation

Cover the shared feedback actions; anchored and floating placement; immutable agent text with human movement; resolve-to-stack behavior; provenance display; canvas-wide reviewer inputs; duplicate suppression; retry safety; and the relocated review home.
