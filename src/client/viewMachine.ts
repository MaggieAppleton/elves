/** Canvas only · split · draft only — the three ways to look at a piece. */
export type ViewState = 'canvas' | 'split' | 'draft'

/** The 1-D sequence the drawer moves along. Index 0 = least draft. */
export const VIEW_ORDER: ViewState[] = ['canvas', 'split', 'draft']

/** One step toward more draft (« pulls the drawer wider). Clamps at 'draft'. */
export function moreDraft(v: ViewState): ViewState {
  return VIEW_ORDER[Math.min(VIEW_ORDER.length - 1, VIEW_ORDER.indexOf(v) + 1)]
}

/** One step toward less draft (» pushes the drawer closed). Clamps at 'canvas'. */
export function lessDraft(v: ViewState): ViewState {
  return VIEW_ORDER[Math.max(0, VIEW_ORDER.indexOf(v) - 1)]
}

/** Can the drawer grow from here? (false only when already full draft) */
export const canExpand = (v: ViewState): boolean => v !== 'draft'

/** Can the drawer shrink from here? (false only when already closed) */
export const canCollapse = (v: ViewState): boolean => v !== 'canvas'
