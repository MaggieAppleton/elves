import { atom, type TLShapeId } from 'tldraw'

/**
 * Ephemeral agent-presence store — the soft orange glow that shows where the
 * agent (Claude, via MCP) is looking and working on the canvas.
 *
 * This deliberately lives OUTSIDE tldraw's document store: presence is never
 * written to canvas.json, never in the undo history, never a document record.
 * It is a client-only, reactive overlay that evaporates on reload — exactly what
 * "awareness" should be. The card component reads it via `presenceMode()` inside
 * its (tldraw-`track`ed) render, so glows appear and fade reactively.
 *
 * Two modes, matching the two signals we surface:
 *   - 'looking' — the agent read these cards (read_cards). A calm steady halo
 *     that persists until the agent goes idle (LOOKING_TTL_MS with no refresh).
 *   - 'doing'   — a change-set touched these cards (comment / merge / move /
 *     create / section / group). A brighter pulse that fades over DOING_TTL_MS.
 *
 * All timing is owned here (one place to tune the feel) and driven by
 * setTimeout, so lifetime is deterministic under fake timers in tests.
 */

export type PresenceMode = 'looking' | 'doing'

/** How long a "looking" halo lingers after the last read before it fades. */
export const LOOKING_TTL_MS = 25_000
/** How long a "doing" pulse takes to fade fully after the action. */
export const DOING_TTL_MS = 10_000

const presence = atom<ReadonlyMap<TLShapeId, PresenceMode>>('agent-presence', new Map())
const timers = new Map<TLShapeId, ReturnType<typeof setTimeout>>()

function write(next: Map<TLShapeId, PresenceMode>): void {
  presence.set(next)
}

function scheduleExpiry(id: TLShapeId, ttl: number): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    timers.delete(id)
    const next = new Map(presence.get())
    if (next.delete(id)) write(next)
  }, ttl)
  // A pending glow timer must never keep a test process (or the tab) alive.
  ;(t as { unref?: () => void }).unref?.()
  timers.set(id, t)
}

function set(ids: TLShapeId[], mode: PresenceMode, ttl: number): void {
  if (ids.length === 0) return
  const next = new Map(presence.get())
  for (const id of ids) {
    next.set(id, mode)
    scheduleExpiry(id, ttl)
  }
  write(next)
}

/**
 * Mark cards the agent is looking at (read_cards). Refreshes the idle timer so a
 * burst of reads keeps the halo alive and moves the focus. A card currently in
 * the stronger 'doing' state is left alone — looking never downgrades doing.
 */
export function markLooking(ids: TLShapeId[]): void {
  const cur = presence.get()
  const targets = ids.filter((id) => cur.get(id) !== 'doing')
  set(targets, 'looking', LOOKING_TTL_MS)
}

/**
 * Mark cards the agent just acted on (a change-set landed). Supersedes any
 * 'looking' state so the action reads as the stronger signal, and fades over
 * DOING_TTL_MS.
 */
export function markDoing(ids: TLShapeId[]): void {
  set(ids, 'doing', DOING_TTL_MS)
}

/**
 * The current presence mode for a shape, or null. Reactive: calling this inside
 * a tldraw-tracked render subscribes the card to presence changes.
 */
export function presenceMode(id: TLShapeId): PresenceMode | null {
  return presence.get().get(id) ?? null
}

/** Drop all presence immediately (project switch, teardown, tests). */
export function clearPresence(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  if (presence.get().size > 0) write(new Map())
}
