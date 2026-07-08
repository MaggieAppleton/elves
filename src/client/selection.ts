import { react, type Editor } from 'tldraw'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

// Report the browser's current canvas selection UP to the server so the agent
// can resolve "this" / "these" via the MCP read_selection tool. The mirror image
// of presence (which flows the other way): ephemeral awareness, never persisted.
// Fire-and-forget — a failed report just means the agent sees a slightly stale
// selection, never a broken canvas, so a network blip is logged and dropped.
async function postSelection(projectId: string, shapeIds: string[]): Promise<void> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shapeIds }),
  })
  if (!res.ok) throw new Error(`selection report failed: ${res.status}`)
}

export interface TrackSelectionOptions {
  /** The currently-open project id (null when none). Read fresh on each change so
   * a report is always tagged with the project the selection actually belongs to. */
  getProjectId: () => string | null
  /** Test seam: replace the network POST. */
  post?: (projectId: string, shapeIds: string[]) => void
  /** Coalesce a burst of selection changes (rubber-band, shift-click) into one
   * report. ~200ms reads as instant for a click but spares the server a flurry. */
  debounceMs?: number
}

/**
 * Watch the editor's selection and report it (debounced) to the server. Returns
 * a disposer that stops watching and cancels any pending report — call it when
 * the editor unmounts (project switch) so a stale reactor can't fire against a
 * torn-down store.
 *
 * A deselect (empty selection) is reported too: it's a real state the agent
 * should see ("nothing selected → ask what they mean"), not a no-op.
 */
export function trackSelection(editor: Editor, opts: TrackSelectionOptions): () => void {
  const { getProjectId, debounceMs = 200 } = opts
  const post =
    opts.post ??
    ((pid: string, ids: string[]) =>
      void postSelection(pid, ids).catch((err) => console.error('Elves: selection report failed', err)))

  let timer: ReturnType<typeof setTimeout> | null = null
  // The last id-set actually sent, so a reactor re-run that doesn't change the
  // selection (or a project with no id) doesn't re-POST the same thing.
  let lastSent: string | null = null

  const stop = react('report selection', () => {
    // Reactive read — re-runs this reactor whenever the selection changes.
    const shapeIds = editor.getSelectedShapeIds()
    // Non-reactive reads, captured for the debounced send below.
    const projectId = getProjectId()
    if (!projectId) return
    const key = shapeIds.join(',')
    if (key === lastSent) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      lastSent = key
      post(projectId, shapeIds)
    }, debounceMs)
  })

  return () => {
    stop()
    if (timer) clearTimeout(timer)
  }
}
