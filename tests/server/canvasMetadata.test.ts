import { describe, expect, test } from 'vitest'
import type { ChangeSet } from '../../src/model/changeset'
import type { CanvasSnapshot } from '../../server/store'
import { semanticChangeSetJson } from '../../server/changeSetIdentity'
import {
  SERVER_CANVAS_METADATA_KEY,
  MAX_RECENT_CHANGE_SET_DIGESTS,
  MAX_LEGACY_CHANGE_SET_RECEIPTS,
  MAX_PENDING_CHANGE_SETS,
  MAX_PENDING_CHANGE_SET_BYTES,
  CanvasRevisionExhaustedError,
  ChangeSetSequenceExhaustedError,
  InvalidCanvasMetadataError,
  addPendingChangeSet,
  canvasRevision,
  clearCanvasSnapshot,
  compareChangeSetToken,
  consumeChangeSetSequence,
  ensureCanvasMetadata,
  incrementCanvasRevision,
  legacyChangeSetReceipt,
  nextChangeSetToken,
  pendingChangeSetsForClient,
  publicCanvasSnapshot,
  recentChangeSetDigest,
  recordLegacyChangeSetReceipt,
  replaceCanvasSnapshot,
} from '../../server/canvasMetadata'

function legacy(extra: Record<string, unknown> = {}): CanvasSnapshot {
  return { document: { store: {} }, session: { selected: [] }, ...extra }
}

function note(id: string, text = 'Note'): ChangeSet {
  return {
    id,
    author: 'claude',
    ops: [{ kind: 'create_note_card', text, x: 1, y: 2 }],
  }
}

function ensured(snapshot: CanvasSnapshot = legacy()): CanvasSnapshot {
  return ensureCanvasMetadata(snapshot).snapshot
}

function metadata(snapshot: CanvasSnapshot): any {
  return snapshot[SERVER_CANVAS_METADATA_KEY]
}

describe('metadata creation and validation', () => {
  test('legacy snapshots have revision zero and lazily receive one durable UUID epoch', () => {
    const old = legacy()
    expect(canvasRevision(old)).toBe(0)
    const first = ensureCanvasMetadata(old)
    expect(first.created).toBe(true)
    expect(first.snapshot).not.toBe(old)
    expect(metadata(first.snapshot)).toMatchObject({
      revision: 0,
      epoch: expect.stringMatching(/^[0-9a-f-]{36}$/),
      nextSequence: 0,
      recentDigests: [],
      pendingChangeSets: [],
      legacyReceipts: [],
    })
    const second = ensureCanvasMetadata(first.snapshot)
    expect(second).toEqual({ snapshot: first.snapshot, created: false })
    expect(nextChangeSetToken(second.snapshot)).toEqual({
      epoch: metadata(first.snapshot).epoch,
      sequence: 0,
    })
  })

  test.each([
    ['negative revision', { revision: -1 }],
    ['fractional revision', { revision: 1.5 }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty epoch', { epoch: '' }],
    ['non-string epoch', { epoch: 42 }],
    ['negative sequence', { nextSequence: -1 }],
    ['fractional sequence', { nextSequence: 1.5 }],
    ['unsafe sequence', { nextSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid recent digests', { recentDigests: [{ sequence: -1, digest: 'x' }] }],
    ['invalid pending entries', { pendingChangeSets: [{}] }],
    ['invalid legacy receipts', { legacyReceipts: [{ id: 1, digest: 'x' }] }],
  ])('rejects present-but-invalid metadata: %s', (_label, override) => {
    const valid = metadata(ensured())
    const snapshot = legacy({ [SERVER_CANVAS_METADATA_KEY]: { ...valid, ...override } })
    expect(() => canvasRevision(snapshot)).toThrow(InvalidCanvasMetadataError)
    expect(() => ensureCanvasMetadata(snapshot)).toThrow(InvalidCanvasMetadataError)
  })
})

describe('revision and sequence state', () => {
  test('increments revision and sequence exactly once without changing epoch', () => {
    const start = ensured()
    const token = nextChangeSetToken(start)
    const revised = incrementCanvasRevision(start)
    expect(canvasRevision(revised)).toBe(1)
    expect(nextChangeSetToken(revised)).toEqual(token)

    const consumed = consumeChangeSetSequence(start, 'digest-0')
    expect(canvasRevision(consumed)).toBe(1)
    expect(nextChangeSetToken(consumed)).toEqual({ epoch: token.epoch, sequence: 1 })
    expect(recentChangeSetDigest(consumed, 0)).toBe('digest-0')
    expect(canvasRevision(start)).toBe(0)
    expect(nextChangeSetToken(start).sequence).toBe(0)
  })

  test('compares exact, consumed, future, and wrong-epoch tokens', () => {
    const start = ensured()
    const token = nextChangeSetToken(start)
    expect(compareChangeSetToken(start, token)).toBe('current')
    expect(compareChangeSetToken(start, { ...token, sequence: 1 })).toBe('sequence-ahead')
    expect(compareChangeSetToken(start, { epoch: 'wrong', sequence: 0 })).toBe('epoch-mismatch')
    const consumed = consumeChangeSetSequence(start, 'digest')
    expect(compareChangeSetToken(consumed, token)).toBe('consumed')
  })

  test('revision exhaustion throws without wrapping or mutating', () => {
    const start = ensured()
    const atLimit = legacy({
      [SERVER_CANVAS_METADATA_KEY]: { ...metadata(start), revision: Number.MAX_SAFE_INTEGER },
    })
    expect(() => incrementCanvasRevision(atLimit)).toThrow(CanvasRevisionExhaustedError)
    expect(canvasRevision(atLimit)).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('sequence exhaustion throws without wrapping or mutating', () => {
    const start = ensured()
    const atLimit = legacy({
      [SERVER_CANVAS_METADATA_KEY]: { ...metadata(start), nextSequence: Number.MAX_SAFE_INTEGER },
    })
    expect(() => consumeChangeSetSequence(atLimit, 'digest')).toThrow(ChangeSetSequenceExhaustedError)
    expect(nextChangeSetToken(atLimit).sequence).toBe(Number.MAX_SAFE_INTEGER)
    expect(canvasRevision(atLimit)).toBe(0)
  })

  test('recent digest history evicts FIFO after 256 entries without resetting sequence', () => {
    let snapshot = ensured()
    for (let sequence = 0; sequence <= MAX_RECENT_CHANGE_SET_DIGESTS; sequence++) {
      snapshot = consumeChangeSetSequence(snapshot, `digest-${sequence}`)
    }
    expect(metadata(snapshot).recentDigests).toHaveLength(MAX_RECENT_CHANGE_SET_DIGESTS)
    expect(recentChangeSetDigest(snapshot, 0)).toBeUndefined()
    expect(recentChangeSetDigest(snapshot, 1)).toBe('digest-1')
    expect(recentChangeSetDigest(snapshot, 256)).toBe('digest-256')
    expect(nextChangeSetToken(snapshot).sequence).toBe(257)
    expect(canvasRevision(snapshot)).toBe(257)
  })
})

describe('bounded pending and legacy compatibility state', () => {
  test('pending entries are capped at 32 and exposed without internal digests', () => {
    let snapshot = ensured()
    const epoch = nextChangeSetToken(snapshot).epoch
    for (let index = 0; index < MAX_PENDING_CHANGE_SETS; index++) {
      const result = addPendingChangeSet(snapshot, note(`pending-${index}`), `digest-${index}`)
      expect(result.status).toBe('added')
      if (result.status === 'added') snapshot = result.snapshot
    }
    const overflow = addPendingChangeSet(snapshot, note('overflow'), 'overflow')
    expect(overflow).toEqual({ status: 'full', snapshot: null })
    const pending = pendingChangeSetsForClient(snapshot)
    expect(pending).toHaveLength(MAX_PENDING_CHANGE_SETS)
    expect(pending[0]).toEqual({
      token: { epoch, sequence: 0 },
      changeSet: note('pending-0'),
    })
    expect(pending[0]).not.toHaveProperty('digest')
  })

  test('pending aggregate accepts exactly 4 MB and rejects one additional byte', () => {
    let snapshot = ensured()
    for (let index = 0; index < 4; index++) {
      const base = note(`million-${index}`, '')
      const overhead = Buffer.byteLength(semanticChangeSetJson(base), 'utf8')
      const exact = note(`million-${index}`, 'x'.repeat(1_000_000 - overhead))
      expect(Buffer.byteLength(semanticChangeSetJson(exact), 'utf8')).toBe(1_000_000)
      const result = addPendingChangeSet(snapshot, exact, `digest-${index}`)
      expect(result.status).toBe('added')
      if (result.status === 'added') snapshot = result.snapshot
    }
    expect(pendingChangeSetsForClient(snapshot).reduce(
      (total, entry) => total + Buffer.byteLength(semanticChangeSetJson(entry.changeSet), 'utf8'),
      0,
    )).toBe(MAX_PENDING_CHANGE_SET_BYTES)
    expect(addPendingChangeSet(snapshot, note('one-more-byte', 'x'), 'overflow'))
      .toEqual({ status: 'too-large', snapshot: null })
  })

  test('legacy receipt history is FIFO-bounded at 256 and prototype-safe', () => {
    let snapshot = ensured()
    for (let index = 0; index <= MAX_LEGACY_CHANGE_SET_RECEIPTS; index++) {
      snapshot = recordLegacyChangeSetReceipt(snapshot, `id-${index}`, `digest-${index}`)
    }
    expect(metadata(snapshot).legacyReceipts).toHaveLength(MAX_LEGACY_CHANGE_SET_RECEIPTS)
    expect(legacyChangeSetReceipt(snapshot, 'id-0')).toBeUndefined()
    expect(legacyChangeSetReceipt(snapshot, 'id-256')).toBe('digest-256')
    const prototypeId = recordLegacyChangeSetReceipt(snapshot, '__proto__', 'prototype-digest')
    expect(legacyChangeSetReceipt(prototypeId, '__proto__')).toBe('prototype-digest')
  })
})

describe('public snapshots, replacement, and clear', () => {
  test('public snapshots strip server metadata without mutating stored state', () => {
    const stored = ensured()
    const publicSnapshot = publicCanvasSnapshot(stored)
    expect(publicSnapshot).not.toHaveProperty(SERVER_CANVAS_METADATA_KEY)
    expect(stored).toHaveProperty(SERVER_CANVAS_METADATA_KEY)
    expect(publicSnapshot.document).toEqual(stored.document)
  })

  test('replacement strips forged incoming metadata and preserves protocol state', () => {
    let current = ensured()
    current = consumeChangeSetSequence(current, 'digest-0')
    const pending = addPendingChangeSet(current, note('pending'), 'pending-digest')
    expect(pending.status).toBe('added')
    if (pending.status === 'added') current = pending.snapshot
    current = recordLegacyChangeSetReceipt(current, 'legacy-id', 'legacy-digest')
    const before = metadata(current)
    const incoming = legacy({
      document: { store: { replacement: true } },
      [SERVER_CANVAS_METADATA_KEY]: {
        revision: 999,
        epoch: 'forged',
        nextSequence: 999,
      },
    })
    const replaced = replaceCanvasSnapshot(current, incoming)
    expect(replaced.document).toEqual({ store: { replacement: true } })
    expect(metadata(replaced)).toMatchObject({
      revision: before.revision + 1,
      epoch: before.epoch,
      nextSequence: before.nextSequence,
      recentDigests: before.recentDigests,
      pendingChangeSets: before.pendingChangeSets,
      legacyReceipts: before.legacyReceipts,
    })
    expect(metadata(replaced).epoch).not.toBe('forged')
  })

  test('clear writes a tombstone, advances revision once, and rotates the epoch', () => {
    let current = ensured()
    current = consumeChangeSetSequence(current, 'digest-0')
    const pending = addPendingChangeSet(current, note('pending'), 'pending-digest')
    if (pending.status === 'added') current = pending.snapshot
    current = recordLegacyChangeSetReceipt(current, 'legacy', 'digest')
    const oldRevision = canvasRevision(current)
    const oldToken = nextChangeSetToken(current)
    const cleared = clearCanvasSnapshot(current)
    expect(cleared.document).toBeNull()
    expect(cleared.session).toBeNull()
    expect(canvasRevision(cleared)).toBe(oldRevision + 1)
    expect(nextChangeSetToken(cleared)).toMatchObject({ sequence: 0 })
    expect(nextChangeSetToken(cleared).epoch).not.toBe(oldToken.epoch)
    expect(compareChangeSetToken(cleared, oldToken)).toBe('epoch-mismatch')
    expect(metadata(cleared).recentDigests).toEqual([])
    expect(metadata(cleared).pendingChangeSets).toEqual([])
    expect(metadata(cleared).legacyReceipts).toEqual([])
  })

  test('replacement and clear refuse revision wrap at the safe-integer ceiling', () => {
    const start = ensured()
    const atLimit = legacy({
      [SERVER_CANVAS_METADATA_KEY]: { ...metadata(start), revision: Number.MAX_SAFE_INTEGER },
    })
    expect(() => replaceCanvasSnapshot(atLimit, legacy())).toThrow(CanvasRevisionExhaustedError)
    expect(() => clearCanvasSnapshot(atLimit)).toThrow(CanvasRevisionExhaustedError)
    expect(canvasRevision(atLimit)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
