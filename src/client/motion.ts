// Reduced-motion support shared by any code that decides whether to run a
// CSS transition / tldraw camera animation or jump straight to the end state.

/** True when the user's OS/browser setting asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * Pure guard for a `transitionend` listener that should fire only for the
 * specific width transition on `element` — not for unrelated transitions
 * (e.g. a child's color/opacity transition) that bubble up to the same
 * listener.
 */
export function isElementWidthTransitionEnd(
  event: Pick<TransitionEvent, 'target' | 'propertyName'>,
  element: EventTarget,
): boolean {
  return event.target === element && event.propertyName === 'width'
}
