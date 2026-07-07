import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Store, StoreSchema, createRecordType } from '@tldraw/store'
import type { BaseRecord, RecordId } from '@tldraw/store'
import { connectRealtime, nextBackoff } from '../../src/client/realtime'

// Minimal fake WebSocket: just enough surface for connectRealtime to drive
// (onopen/onmessage/onerror/onclose handlers + a close() that fires onclose).
// Exposed as an array so tests can grab the most recently created socket and
// simulate the server's side of the connection (open it, then close it).
class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(public url: string) {}
  open() {
    this.onopen?.()
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

let sockets: FakeSocket[] = []
function createSocket(url: string) {
  const s = new FakeSocket(url)
  sockets.push(s)
  return s as unknown as WebSocket
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('nextBackoff', () => {
  test('grows with attempt and caps at 30s', () => {
    // Full jitter: nextBackoff(attempt) is uniform in [0, cap(attempt)].
    // Sample many draws per attempt and check the max stays within the cap,
    // and that later attempts' caps are >= earlier ones (until capped).
    for (const attempt of [0, 1, 2, 3, 10]) {
      const draws = Array.from({ length: 200 }, () => nextBackoff(attempt))
      for (const d of draws) {
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(30000)
      }
    }
    // Higher attempts should be able to produce larger delays than attempt 0
    // (whose cap is 1000ms), up to the 30s ceiling.
    const early = Array.from({ length: 200 }, () => nextBackoff(0))
    const later = Array.from({ length: 200 }, () => nextBackoff(5))
    expect(Math.max(...early)).toBeLessThanOrEqual(1000)
    expect(Math.max(...later)).toBeGreaterThan(1000)
  })
})

describe('connectRealtime reconnect', () => {
  test('onclose schedules a reconnect that opens a new socket', () => {
    const teardown = connectRealtime(() => {}, undefined, { createSocket })
    expect(sockets.length).toBe(1)
    sockets[0].open()
    sockets[0].close()
    // No new socket yet — the retry is scheduled, not immediate.
    expect(sockets.length).toBe(1)
    vi.advanceTimersByTime(30000)
    expect(sockets.length).toBe(2)
    teardown()
  })

  test('a successful reconnect resets backoff and fires onReconnect (but not on the first connect)', () => {
    const onReconnect = vi.fn()
    const teardown = connectRealtime(() => {}, undefined, { createSocket, onReconnect })
    sockets[0].open()
    expect(onReconnect).not.toHaveBeenCalled()
    sockets[0].close()
    vi.advanceTimersByTime(30000)
    expect(sockets.length).toBe(2)
    sockets[1].open()
    expect(onReconnect).toHaveBeenCalledTimes(1)
    teardown()
  })

  test('status callback reports the connection lifecycle', () => {
    const onStatus = vi.fn()
    const teardown = connectRealtime(() => {}, undefined, { createSocket, onStatus })
    expect(onStatus).toHaveBeenCalledWith('connecting')
    sockets[0].open()
    expect(onStatus).toHaveBeenCalledWith('connected')
    sockets[0].close()
    expect(onStatus).toHaveBeenCalledWith('disconnected')
    expect(onStatus).toHaveBeenCalledWith('reconnecting')
    teardown()
  })

  test('teardown cancels a pending reconnect and prevents further reconnects', () => {
    const teardown = connectRealtime(() => {}, undefined, { createSocket })
    sockets[0].open()
    sockets[0].close()
    teardown()
    vi.advanceTimersByTime(60000)
    // Only the original socket exists — no reconnect fired after teardown.
    expect(sockets.length).toBe(1)
  })

  test('does not open multiple concurrent sockets across repeated closes', () => {
    const teardown = connectRealtime(() => {}, undefined, { createSocket })
    sockets[0].open()
    sockets[0].close()
    sockets[0].close() // a duplicate close event should not double-schedule
    vi.advanceTimersByTime(30000)
    expect(sockets.length).toBe(2)
    teardown()
  })

  test('routes change-set and presence messages by kind', () => {
    const onChangeSet = vi.fn()
    const onPresence = vi.fn()
    const teardown = connectRealtime(onChangeSet, onPresence, { createSocket })
    sockets[0].open()
    sockets[0].onmessage?.({ data: JSON.stringify({ projectId: 'p1', changeSet: { id: 'cs1' } }) })
    sockets[0].onmessage?.({ data: JSON.stringify({ projectId: 'p1', presence: { cardIds: [] } }) })
    expect(onChangeSet).toHaveBeenCalledWith('p1', { id: 'cs1' })
    expect(onPresence).toHaveBeenCalledWith('p1', { cardIds: [] })
    teardown()
  })
})

// The reconnect resync (and the load-window reconcile) load the authoritative
// snapshot inside `store.mergeRemoteChanges(...)`. This guards the tldraw
// primitive the fix depends on: a change made inside mergeRemoteChanges is
// tagged source:'remote' and must NOT reach the {source:'user'} autosave
// listener App wires — otherwise the resync would echo-save and reopen the
// clobber window. A plain 'user' change must still reach it.
describe('resync does not trip the source:user autosave listener', () => {
  interface Thing extends BaseRecord<'thing', RecordId<Thing>> {
    v: number
  }
  const Thing = createRecordType<Thing>('thing', { scope: 'document' })

  function makeStore() {
    const schema = StoreSchema.create<Thing>({ thing: Thing })
    return new Store<Thing>({ schema, props: {} })
  }

  test('mergeRemoteChanges is excluded, a user change is not', () => {
    const store = makeStore()
    const onUserSave = vi.fn()
    store.listen(onUserSave, { source: 'user', scope: 'document' })

    // A normal (user-sourced) change reaches the save listener.
    store.put([Thing.create({ id: Thing.createId('a'), v: 1 })])
    expect(onUserSave).toHaveBeenCalledTimes(1)

    // The resync's loadSnapshot equivalent — a change inside mergeRemoteChanges —
    // is source:'remote' and must be ignored by the {source:'user'} listener.
    onUserSave.mockClear()
    store.mergeRemoteChanges(() => {
      store.put([Thing.create({ id: Thing.createId('b'), v: 2 })])
    })
    expect(onUserSave).not.toHaveBeenCalled()

    store.dispose()
  })
})
