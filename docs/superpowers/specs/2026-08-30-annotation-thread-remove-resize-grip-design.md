# Remove Annotation Thread Resize Grip Design

## Goal

Remove the visible manual resize affordance from every shared annotation reply composer, leaving a quiet editor that grows only with its draft.

## Scope

`AnnotationThread` keeps its collapsed Reply trigger and autosizing textarea. It no longer exposes a resize grip, keyboard separator semantics, pointer-resize state, or manual minimum-height state. Canvas annotation popovers and the comment-states gallery remain in sync because both render this shared component.

## Interaction and accessibility

Opening Reply focuses the textarea. Its height follows the draft's content from the existing 76px baseline. The circular Send action remains inset 8px from the textarea's lower-right corner. With no manual resizer, no visual element sits outside or alongside the textarea.

## Verification

Update component tests to assert that no resize grip is rendered and remove pointer/keyboard resize contracts. Retain reply disclosure, autosize, disabled/running, Send placement, and canvas-popover tests. Run the focused component tests, typecheck, and the full suite before updating the existing PR.
