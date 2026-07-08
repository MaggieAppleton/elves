// Pure helpers for the steady-state realtime resync (see issue #28): rather
// than replaying a broadcast change-set locally (which mints fresh shape ids
// and echo-saves, clobbering the server's authoritative document), the tab
// re-fetches the server's snapshot and loads it verbatim. These two functions
// let the caller figure out which card/shape ids are new or changed by that
// reload, so the agent-presence "doing" glow can still be driven off it.

/** Minimal shape of a tldraw record we need: an id, a typeName, and whatever else. */
export type RecordLike = { id: string; typeName?: string } & object

/** Snapshot a store's records into an id -> record map, restricted to shapes. */
export function shapeRecordsById(records: Iterable<RecordLike>): Map<string, RecordLike> {
  const map = new Map<string, RecordLike>()
  for (const r of records) {
    if (r.typeName === 'shape') map.set(r.id, r)
  }
  return map
}

/**
 * Ids present in `after` that are missing from `before`, or whose record
 * changed. Used to find which cards a resync touched, since the reloaded
 * snapshot carries no per-op "what changed" information the way a locally
 * applied change-set would.
 */
export function diffChangedIds(before: Map<string, RecordLike>, after: Map<string, RecordLike>): string[] {
  const changed: string[] = []
  for (const [id, rec] of after) {
    const prev = before.get(id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(rec)) changed.push(id)
  }
  return changed
}
