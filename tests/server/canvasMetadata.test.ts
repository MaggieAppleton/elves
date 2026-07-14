import { describe, expect, test } from 'vitest'
import { CHANGE_SET_STAMP_META_KEY, changeSetTokenStamp, type ChangeSet } from '../../src/model/changeset'
import type { CanvasSnapshot } from '../../server/store'
import {
  MAX_CHANGE_SET_ARRAY_ITEMS,
  MAX_CHANGE_SET_OPS,
  MAX_CHANGE_SET_SEMANTIC_BYTES,
  changeSetDigest,
  semanticChangeSetJson,
} from '../../server/changeSetIdentity'
import {
  SERVER_CANVAS_METADATA_KEY,
  MAX_RECENT_CHANGE_SET_DIGESTS,
  MAX_LEGACY_CHANGE_SET_RECEIPTS,
  MAX_PENDING_CHANGE_SETS,
  MAX_PENDING_CHANGE_SET_BYTES,
  CanvasRevisionExhaustedError,
  ChangeSetSequenceExhaustedError,
  InvalidCanvasMetadataError,
  PendingMaterializationIncompleteError,
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

function addPending(snapshot: CanvasSnapshot, changeSet: ChangeSet) {
  return addPendingChangeSet(snapshot, changeSet, changeSetDigest(changeSet))
}

function withPending(...changeSets: ChangeSet[]): CanvasSnapshot {
  let snapshot = ensured()
  for (const changeSet of changeSets) {
    const result = addPending(snapshot, changeSet)
    expect(result.status).toBe('added')
    if (result.status === 'added') snapshot = result.snapshot
  }
  return snapshot
}

function stampedShape(
  id: string,
  stamp: string,
  type: 'card' | 'section' | 'question',
  props: Record<string, unknown> = {},
) {
  return {
    id, typeName: 'shape', type,
    meta: { [CHANGE_SET_STAMP_META_KEY]: stamp },
    props,
  }
}

function incomingWith(...records: Record<string, unknown>[]): CanvasSnapshot {
  return {
    document: { store: Object.fromEntries(records.map((record) => [record.id, record])) },
    session: null,
  }
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
  test('rehydration rejects duplicate pending token sequences', () => {
    const duplicate = structuredClone(withPending(note('first'), note('second')))
    metadata(duplicate).pendingChangeSets[1].token.sequence = 0
    expect(() => canvasRevision(duplicate)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects descending pending token sequences', () => {
    const descending = structuredClone(withPending(note('first'), note('second')))
    metadata(descending).pendingChangeSets.reverse()
    expect(() => canvasRevision(descending)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration allows increasing pending token sequences with materialization gaps', () => {
    const gapped = structuredClone(withPending(note('first'), note('second'), note('third')))
    metadata(gapped).pendingChangeSets.splice(1, 1)
    expect(canvasRevision(gapped)).toBe(3)
    expect(pendingChangeSetsForClient(gapped).map((entry) => entry.token.sequence)).toEqual([0, 2])
  })

  test('rehydration rejects a pending digest that is not the canonical payload digest', () => {
    const snapshot = structuredClone(withPending(note('pending')))
    metadata(snapshot).pendingChangeSets[0].digest = 'forged'
    metadata(snapshot).recentDigests[0].digest = 'forged'
    expect(() => canvasRevision(snapshot)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects a mismatched retained digest for pending state', () => {
    const mismatched = structuredClone(withPending(note('pending')))
    metadata(mismatched).recentDigests[0].digest = 'different'
    expect(() => canvasRevision(mismatched)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects a missing retained digest for pending state', () => {
    const missing = structuredClone(withPending(note('pending')))
    metadata(missing).recentDigests = []
    expect(() => canvasRevision(missing)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects pending change sets beyond Task 1 operation bounds', () => {
    const oversized: ChangeSet = {
      id: 'too-many-ops',
      author: 'claude',
      ops: Array.from({ length: MAX_CHANGE_SET_OPS + 1 }, () => ({
        kind: 'delete_card' as const,
        cardId: 'shape:a',
      })),
    }
    const snapshot = withPending(oversized)
    expect(() => canvasRevision(snapshot)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects pending change sets beyond Task 1 array bounds', () => {
    const oversized: ChangeSet = {
      id: 'too-many-array-items',
      author: 'claude',
      ops: [{
        kind: 'group_cards',
        cardIds: Array.from({ length: MAX_CHANGE_SET_ARRAY_ITEMS + 1 }, (_, index) => `shape:${index}`),
      }],
    }
    const snapshot = withPending(oversized)
    expect(() => canvasRevision(snapshot)).toThrow(InvalidCanvasMetadataError)
  })

  test('rehydration rejects a pending change set beyond the Task 1 semantic byte bound', () => {
    const base = note('too-many-bytes', '')
    const overhead = Buffer.byteLength(semanticChangeSetJson(base), 'utf8')
    const oversized = note(
      'too-many-bytes',
      'x'.repeat(MAX_CHANGE_SET_SEMANTIC_BYTES + 1 - overhead),
    )
    expect(Buffer.byteLength(semanticChangeSetJson(oversized), 'utf8'))
      .toBe(MAX_CHANGE_SET_SEMANTIC_BYTES + 1)
    const snapshot = withPending(oversized)
    expect(() => canvasRevision(snapshot)).toThrow(InvalidCanvasMetadataError)
  })

  test('pending entries are capped at 32 and exposed without internal digests', () => {
    let snapshot = ensured()
    const epoch = nextChangeSetToken(snapshot).epoch
    for (let index = 0; index < MAX_PENDING_CHANGE_SETS; index++) {
      const result = addPending(snapshot, note(`pending-${index}`))
      expect(result.status).toBe('added')
      if (result.status === 'added') snapshot = result.snapshot
    }
    const overflow = addPending(snapshot, note('overflow'))
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
      const result = addPending(snapshot, exact)
      expect(result.status).toBe('added')
      if (result.status === 'added') snapshot = result.snapshot
    }
    expect(pendingChangeSetsForClient(snapshot).reduce(
      (total, entry) => total + Buffer.byteLength(semanticChangeSetJson(entry.changeSet), 'utf8'),
      0,
    )).toBe(MAX_PENDING_CHANGE_SET_BYTES)
    expect(addPending(snapshot, note('one-more-byte', 'x')))
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
    const pending = addPending(current, note('pending'))
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

  test('versioned replacement removes pending only for the exact complete created-kind multiset', () => {
    const changeSet: ChangeSet = {
      id: 'multiset', author: 'claude',
      ops: [
        { kind: 'create_note_card', text: 'One', x: 0, y: 0 },
        { kind: 'create_note_card', text: 'Two', x: 0, y: 100 },
        {
          kind: 'create_reference', x: 0, y: 200,
          reference: {
            url: 'https://example.com', refType: 'link', title: 'Example', authors: [],
            siteName: 'example.com', year: null, venue: null, description: null,
            faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
            fetchedBy: 'claude', fetchedAt: 'T',
          },
        },
        { kind: 'create_figure_card', title: 'Figure', description: 'Plan', x: 0, y: 300 },
        { kind: 'create_section', text: 'Section', x: 300, y: 0 },
        { kind: 'create_question', text: 'Question?', x: 600, y: 0 },
      ],
    }
    const current = withPending(changeSet)
    const pending = pendingChangeSetsForClient(current)[0]!
    const stamp = changeSetTokenStamp(pending.token)
    const incoming = incomingWith(
      stampedShape('shape:n1', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:n2', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:r1', stamp, 'card', { kind: 'note', noteKind: 'reference' }),
      stampedShape('shape:f1', stamp, 'card', { kind: 'figure' }),
      stampedShape('shape:s1', stamp, 'section'),
      stampedShape('shape:q1', stamp, 'question'),
    )

    const replaced = replaceCanvasSnapshot(current, incoming, { materializePending: true })
    expect(pendingChangeSetsForClient(replaced)).toEqual([])
    expect(canvasRevision(replaced)).toBe(canvasRevision(current) + 1)
    expect(replaced.document).toEqual(incoming.document)
  })

  test.each([
    ['partial', (stamp: string) => [
      stampedShape('shape:n1', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:s1', stamp, 'section'),
    ]],
    ['wrong kind', (stamp: string) => [
      stampedShape('shape:n1', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:n2', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:q1', stamp, 'question'),
    ]],
    ['duplicated unrelated record', (stamp: string) => [
      stampedShape('shape:n1', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:n2', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:n3', stamp, 'card', { kind: 'note', noteKind: 'text' }),
      stampedShape('shape:s1', stamp, 'section'),
    ]],
  ])('versioned replacement rejects a %s stamp set atomically', (_label, records) => {
    const changeSet: ChangeSet = {
      id: 'incomplete', author: 'claude',
      ops: [
        { kind: 'create_note_card', text: 'One', x: 0, y: 0 },
        { kind: 'create_note_card', text: 'Two', x: 0, y: 100 },
        { kind: 'create_section', text: 'Section', x: 300, y: 0 },
      ],
    }
    const current = withPending(changeSet)
    const pending = pendingChangeSetsForClient(current)[0]!
    const before = structuredClone(current)
    expect(() => replaceCanvasSnapshot(
      current, incomingWith(...records(changeSetTokenStamp(pending.token))),
      { materializePending: true },
    )).toThrow(PendingMaterializationIncompleteError)
    expect(current).toEqual(before)
  })

  test.each([
    ['malformed note', { kind: 'note' }],
    ['image note', { kind: 'note', noteKind: 'image' }],
  ])('a single exact-stamped %s cannot clear a pending text-note create', (_label, props) => {
    const current = withPending(note('strict-note-kind'))
    const pending = pendingChangeSetsForClient(current)[0]!
    const incoming = incomingWith(stampedShape(
      'shape:n1', changeSetTokenStamp(pending.token), 'card', props,
    ))

    expect(() => replaceCanvasSnapshot(current, incoming, { materializePending: true }))
      .toThrow(PendingMaterializationIncompleteError)
  })

  test('versioned replacement permits zero exact-stamped records and retains pending', () => {
    const current = withPending(note('unrelated-save'))
    const pending = pendingChangeSetsForClient(current)[0]!
    const wrongStamp = `${changeSetTokenStamp(pending.token)}-wrong`
    const incoming = incomingWith(stampedShape(
      'shape:n1', wrongStamp, 'card', { kind: 'note', noteKind: 'text' },
    ))

    const replaced = replaceCanvasSnapshot(current, incoming, { materializePending: true })
    expect(pendingChangeSetsForClient(replaced)).toEqual([pending])
    expect(replaced.document).toEqual(incoming.document)
  })

  test('versioned replacement evaluates multiple pending entries independently', () => {
    const noteChangeSet = note('note-pending')
    const sectionChangeSet: ChangeSet = {
      id: 'section-pending', author: 'claude',
      ops: [{ kind: 'create_section', text: 'Section', x: 0, y: 0 }],
    }
    const current = withPending(noteChangeSet, sectionChangeSet)
    const [notePending, sectionPending] = pendingChangeSetsForClient(current)
    const incoming = incomingWith(stampedShape(
      'shape:s1', changeSetTokenStamp(sectionPending!.token), 'section',
    ))

    const replaced = replaceCanvasSnapshot(current, incoming, { materializePending: true })
    expect(pendingChangeSetsForClient(replaced)).toEqual([notePending])
  })

  test('one invalid pending materialization rejects removal of another completed entry', () => {
    const noteChangeSet = note('complete-note')
    const sectionChangeSet: ChangeSet = {
      id: 'invalid-section', author: 'claude',
      ops: [{ kind: 'create_section', text: 'Section', x: 0, y: 0 }],
    }
    const current = withPending(noteChangeSet, sectionChangeSet)
    const [notePending, sectionPending] = pendingChangeSetsForClient(current)
    const incoming = incomingWith(
      stampedShape(
        'shape:n1', changeSetTokenStamp(notePending!.token),
        'card', { kind: 'note', noteKind: 'text' },
      ),
      stampedShape('shape:q1', changeSetTokenStamp(sectionPending!.token), 'question'),
    )

    expect(() => replaceCanvasSnapshot(current, incoming, { materializePending: true }))
      .toThrow(PendingMaterializationIncompleteError)
    expect(pendingChangeSetsForClient(current)).toEqual([notePending, sectionPending])
  })

  test('legacy replacement never confirms pending, even when the complete stamp is present', () => {
    const current = withPending(note('legacy-keeps-pending'))
    const pending = pendingChangeSetsForClient(current)[0]!
    const incoming = incomingWith(stampedShape(
      'shape:n1', changeSetTokenStamp(pending.token), 'card', { kind: 'note', noteKind: 'text' },
    ))

    const replaced = replaceCanvasSnapshot(current, incoming)
    expect(pendingChangeSetsForClient(replaced)).toEqual([pending])
  })

  test('clear writes a tombstone, advances revision once, and rotates the epoch', () => {
    let current = ensured()
    current = consumeChangeSetSequence(current, 'digest-0')
    const pending = addPending(current, note('pending'))
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
