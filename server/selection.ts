import type { CardKind } from '../src/model/types'
import type { CardMap } from './digest'

/**
 * The browser's current canvas selection, held in memory so the agent (via the
 * MCP `read_selection` tool) can see what the user has selected and act on
 * "this" / "these" / "the selected card".
 *
 * Like presence (see server/realtime.ts), this is EPHEMERAL awareness state: it
 * is never persisted to disk, never in the canvas document, and evaporates when
 * the server restarts. Unlike presence, the arrow points the other way — the
 * browser reports its selection UP to the server (POST /selection), and the
 * agent polls it DOWN (GET /selection) only when it acts.
 *
 * A single global slot, not per-project: there is one user, and "this" refers to
 * whatever they last selected. The stored `projectId` tells the agent which
 * project that selection lives in, so it doesn't need to know the project first.
 * The last tab to report wins.
 */
export interface SelectionState {
  projectId: string
  shapeIds: string[]
  /** ISO time the server received this selection — the agent judges staleness. */
  selectedAt: string
}

export interface SelectionStore {
  /** Replace the current selection. An empty `shapeIds` records a deselection. */
  set(projectId: string, shapeIds: string[], at: string): void
  /** The latest reported selection, or null if none has been reported yet. */
  get(): SelectionState | null
}

export function createSelectionStore(): SelectionStore {
  let current: SelectionState | null = null
  return {
    set(projectId, shapeIds, at) {
      current = { projectId, shapeIds, selectedAt: at }
    },
    get() {
      return current
    },
  }
}

/**
 * One selected shape, enriched from the canvas map so the agent gets enough to
 * orient in a single call. Cards carry their kind + gist (the same one-line
 * summary `read_map` shows); sections and questions carry their label/question
 * text; groups carry their member count. The agent drills into card text with
 * read_cards when it needs the full content.
 */
export type SelectedShape =
  | { id: string; type: 'card'; kind: CardKind; gist: string }
  | { id: string; type: 'section'; text: string }
  | { id: string; type: 'question'; text: string }
  | { id: string; type: 'group'; memberCount: number }

/**
 * Resolve the reported shape ids against the project's current canvas map,
 * preserving the order the user selected them in. Ids that no longer exist
 * (a card deleted since it was selected, or a hidden/merged-away shape) are
 * dropped rather than reported as ghosts — the map only contains live shapes.
 */
export function enrichSelection(map: CardMap, shapeIds: string[]): SelectedShape[] {
  const byId = new Map<string, SelectedShape>()
  for (const c of map.cards) byId.set(c.id, { id: c.id, type: 'card', kind: c.kind, gist: c.gist })
  for (const s of map.sections) byId.set(s.id, { id: s.id, type: 'section', text: s.text })
  for (const q of map.questions) byId.set(q.id, { id: q.id, type: 'question', text: q.text })
  for (const g of map.groups) byId.set(g.id, { id: g.id, type: 'group', memberCount: g.memberCount })
  return shapeIds.map((id) => byId.get(id)).filter((s): s is SelectedShape => s !== undefined)
}
