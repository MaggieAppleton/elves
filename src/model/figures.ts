import type { FigureStatus } from './types'

/**
 * A figure card plans a visual — an illustration, diagram, or interactive
 * animation — sitting at its narrative position among the prose and notes. It
 * carries a working `figureTitle`, a description (the card's `text`), and a
 * `figureStatus` that firms up as the visual takes shape. This module is the
 * pure logic around that status: the canonical order and how clicking the chip
 * advances it. It touches no shape and calls no network, so it is trivially
 * unit-testable.
 */

/** The status cycle order, mirroring the FigureStatus union in types.ts. */
export const FIGURE_STATUSES: readonly FigureStatus[] = ['idea', 'sketched', 'final']

/**
 * The next status when the chip is clicked. Wraps `final → idea` so the chip is
 * a simple three-way cycle — a figure can always be walked back to a rough idea.
 * An unrecognized value resets to the first status rather than getting stuck.
 */
export function nextFigureStatus(status: FigureStatus): FigureStatus {
  const i = FIGURE_STATUSES.indexOf(status)
  return FIGURE_STATUSES[(i + 1) % FIGURE_STATUSES.length] ?? FIGURE_STATUSES[0]
}
