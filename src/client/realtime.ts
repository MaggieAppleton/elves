import { ChangeSet } from '../model/changeset'
import { PresenceMessage } from '../model/presence'
import { Review } from '../model/reviews'

const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

// Exponential backoff with full jitter, capped at MAX_BACKOFF_MS. `attempt` is
// 0-indexed (the first retry after a disconnect uses attempt 0). Exported so
// the schedule can be unit-tested without opening a socket.
export function nextBackoff(attempt: number): number {
  const cap = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.random() * cap
}

export interface ConnectRealtimeOptions {
  // Fires on every connect attempt's outcome so the UI can show an unobtrusive
  // indicator instead of silently going stale.
  onStatus?: (status: RealtimeStatus) => void
  // Fires after a successful RE-connection (never the very first connect).
  // The caller supplies this to re-fetch and loadSnapshot the CURRENTLY open
  // project's authoritative canvas — mirroring reconcilePendingChangeSets —
  // before any local autosave can overwrite agent work persisted server-side
  // during the outage.
  onReconnect?: () => void
  // Test seam: inject a fake socket instead of opening a real one.
  createSocket?: (url: string) => WebSocket
  // Fires when a project's review-pass list changes (summoned / claimed /
  // completed / dismissed) so the review panel updates live. Project metadata,
  // never document state.
  onReviews?: (projectId: string, reviews: Review[]) => void
}

// Messages are tagged with the project id; the caller decides whether the
// change-set / presence signal is for the project it currently has open. Three
// message kinds share the socket: `{ changeSet }` (durable document ops),
// `{ presence }` (ephemeral "the agent is looking here" — never persisted), and
// `{ reviews }` (the project's review-pass list after a mutation).
//
// Reconnects with exponential backoff + jitter on any disconnect (server
// restart, laptop sleep/wake, network blip) so the app doesn't silently stop
// receiving agent change-sets until a full page reload. The returned teardown
// cancels any pending retry and prevents further reconnects.
export function connectRealtime(
  onChangeSet: (projectId: string, cs: ChangeSet) => void,
  onPresence?: (projectId: string, presence: PresenceMessage) => void,
  options: ConnectRealtimeOptions = {},
): () => void {
  const { onStatus, onReconnect, onReviews, createSocket = (u: string) => new WebSocket(u) } = options
  const url = BASE.replace(/^http/, 'ws') + '/ws'

  let disposed = false
  let ws: WebSocket | null = null
  let attempt = 0
  let connectedBefore = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleReconnect = () => {
    if (disposed || retryTimer !== null) return
    onStatus?.('reconnecting')
    const delay = nextBackoff(attempt)
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  const connect = () => {
    if (disposed) return
    onStatus?.(connectedBefore ? 'reconnecting' : 'connecting')
    const socket = createSocket(url)
    ws = socket
    socket.onopen = () => {
      if (disposed) return
      attempt = 0
      onStatus?.('connected')
      // Only a RE-connection needs a resync; the first connect starts from
      // whatever the canvas load already fetched.
      if (connectedBefore) onReconnect?.()
      connectedBefore = true
    }
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.changeSet) onChangeSet(msg.projectId, msg.changeSet)
        else if (msg.presence) onPresence?.(msg.projectId, msg.presence)
        else if (msg.reviews) onReviews?.(msg.projectId, msg.reviews)
      } catch (err) {
        console.error('Elves: bad realtime message', err)
      }
    }
    socket.onerror = (err) => console.error('Elves: realtime socket error', err)
    socket.onclose = () => {
      ws = null
      if (disposed) return
      onStatus?.('disconnected')
      scheduleReconnect()
    }
  }

  connect()

  return () => {
    disposed = true
    clearRetry()
    ws?.close()
    ws = null
  }
}
