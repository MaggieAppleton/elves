import { describe, expect, test } from 'vitest'
import { changeSetTokenStamp, type ChangeSet } from '../../src/model/changeset'
import type { CanvasSnapshot } from '../../server/store'
import {
  MAX_LEGACY_CHANGE_SET_RECEIPTS,
  MAX_PENDING_CHANGE_SETS,
  SERVER_CANVAS_METADATA_KEY,
  canvasRevision,
  consumeChangeSetSequence,
  ensureCanvasMetadata,
  incrementCanvasRevision,
  legacyChangeSetReceipt,
  nextChangeSetToken,
  pendingChangeSetsForClient,
  recentChangeSetDigest,
  replaceCanvasSnapshot,
} from '../../server/canvasMetadata'
import { changeSetDigest, semanticChangeSetJson } from '../../server/changeSetIdentity'
import {
  admitLegacyChangeSet,
  admitTokenizedChangeSet,
} from '../../server/changeSetAdmission'

function canvas(): CanvasSnapshot {
  return {
    document: {
      store: {
        'page:page': { id: 'page:page', typeName: 'page' },
        'shape:a': {
          id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
          parentId: 'page:page',
          props: {
            w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'transcribed',
            text: 'A', authoredBy: 'claude', comments: [], mergedInto: null,
          },
        },
        'shape:b': {
          id: 'shape:b', typeName: 'shape', type: 'card', x: 300, y: 0,
          parentId: 'page:page',
          props: {
            w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'transcribed',
            text: 'B', authoredBy: 'claude', comments: [], mergedInto: null,
          },
        },
        'shape:prose': {
          id: 'shape:prose', typeName: 'shape', type: 'card', x: 0, y: 200,
          parentId: 'page:page',
          props: {
            w: 240, h: 120, kind: 'prose', noteKind: null, origin: null,
            text: 'User prose', authoredBy: null, comments: [], mergedInto: null,
          },
        },
        'shape:section': {
          id: 'shape:section', typeName: 'shape', type: 'section', x: 0, y: 400,
          parentId: 'page:page', props: { text: 'Section', authoredBy: 'claude' },
        },
        'shape:group': {
          id: 'shape:group', typeName: 'shape', type: 'group', x: 0, y: 0,
          parentId: 'page:page', props: {},
        },
        'shape:question': {
          id: 'shape:question', typeName: 'shape', type: 'question', x: 0, y: 500,
          parentId: 'page:page', props: { text: 'Question?', authoredBy: 'claude' },
        },
      },
    },
    session: null,
  }
}

function ready(snapshot: CanvasSnapshot = canvas()): CanvasSnapshot {
  return ensureCanvasMetadata(snapshot).snapshot
}

function empty(): CanvasSnapshot {
  return ready({ document: null, session: null })
}

function move(id: string, x: number): ChangeSet {
  return {
    id,
    author: 'claude',
    ops: [{ kind: 'move_cards', moves: [{ cardId: 'shape:a', x, y: 0 }] }],
  }
}

function create(id: string, text = id): ChangeSet {
  return {
    id,
    author: 'claude',
    ops: [{ kind: 'create_note_card', text, x: 1, y: 2 }],
  }
}

function summarizeComment(id: string, cardId = 'shape:a', commentId = 'comment:target'): ChangeSet {
  return {
    id,
    author: 'claude',
    ops: [{
      kind: 'set_comment_summary',
      cardId,
      commentId,
      summary: 'Summary',
      summaryOfHash: 'hash',
      summaryBy: 'model',
      summaryAt: 'T',
    }],
  }
}

function addComment(snapshot: CanvasSnapshot, cardId: string, commentId = 'comment:target'): void {
  ;(snapshot as any).document.store[cardId].props.comments.push({
    id: commentId,
    type: null,
    text: 'Comment',
    resolved: false,
    author: 'claude',
    summary: null,
    summaryOfHash: null,
    summaryBy: null,
    summaryAt: null,
  })
}

function admitCurrent(snapshot: CanvasSnapshot, changeSet: ChangeSet) {
  return admitTokenizedChangeSet(
    snapshot,
    nextChangeSetToken(snapshot),
    changeSet,
    changeSetDigest(changeSet),
  )
}

function expectUnchanged(snapshot: CanvasSnapshot, before: string): void {
  expect(JSON.stringify(snapshot)).toBe(before)
}

function expectInvalidForTokenizedAndLegacy(
  start: CanvasSnapshot,
  changeSet: ChangeSet,
  expected: { missing?: string[]; invalidMergeReps?: string[] },
): void {
  const before = JSON.stringify(start)
  expect(admitCurrent(start, changeSet)).toMatchObject({ kind: 'invalid-target', ...expected })
  expectUnchanged(start, before)
  expect(admitLegacyChangeSet(start, changeSet, changeSetDigest(changeSet)))
    .toMatchObject({ kind: 'invalid-target', ...expected })
  expect(legacyChangeSetReceipt(start, changeSet.id)).toBeUndefined()
  expectUnchanged(start, before)
}

describe('tokenized admission', () => {
  test('an exact same-token retry is a verified duplicate and does not apply twice', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const changeSet = create('once')
    const digest = changeSetDigest(changeSet)
    const first = admitTokenizedChangeSet(start, token, changeSet, digest)
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return

    const retry = admitTokenizedChangeSet(first.snapshot, token, changeSet, digest)
    expect(retry).toMatchObject({
      kind: 'duplicate', payloadUnverified: false, revision: 1,
      nextToken: { epoch: token.epoch, sequence: 1 },
    })
    const created = Object.values((first.snapshot as any).document.store)
      .filter((record: any) => record?.type === 'card' && record.props?.text === 'once')
    expect(created).toHaveLength(1)
  })

  test('an exact retry remains a duplicate after serialization and rehydration', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const changeSet = create('restart')
    const first = admitTokenizedChangeSet(start, token, changeSet, changeSetDigest(changeSet))
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return
    const restarted = JSON.parse(JSON.stringify(first.snapshot)) as CanvasSnapshot

    const retry = admitTokenizedChangeSet(restarted, token, changeSet, changeSetDigest(changeSet))
    expect(retry).toMatchObject({ kind: 'duplicate', payloadUnverified: false })
    expect(canvasRevision(restarted)).toBe(1)
  })

  test('an old token stays non-executable after its diagnostic digest is evicted', () => {
    const start = ready()
    const oldToken = nextChangeSetToken(start)
    const firstMove = move('first', 10)
    const first = admitTokenizedChangeSet(start, oldToken, firstMove, changeSetDigest(firstMove))
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return
    const laterMove = move('later', 50)
    const later = admitCurrent(first.snapshot, laterMove)
    expect(later.kind).toBe('applied')
    if (later.kind !== 'applied') return

    let current = later.snapshot
    for (let index = 0; index < 255; index++) {
      current = consumeChangeSetSequence(current, `filler-${index}`)
    }
    const restarted = JSON.parse(JSON.stringify(current)) as CanvasSnapshot
    expect(recentChangeSetDigest(restarted, oldToken.sequence)).toBeUndefined()

    const retry = admitTokenizedChangeSet(
      restarted,
      oldToken,
      firstMove,
      changeSetDigest(firstMove),
    )
    expect(retry).toMatchObject({ kind: 'duplicate', payloadUnverified: true })
    expect((restarted as any).document.store['shape:a'].x).toBe(50)
  })

  test('pending work survives diagnostic eviction, restart, duplicate retry, and materialization', () => {
    const start = empty()
    const token = nextChangeSetToken(start)
    const changeSet = create('evicted-pending', 'Pending after eviction')
    const digest = changeSetDigest(changeSet)
    const queued = admitTokenizedChangeSet(start, token, changeSet, digest)
    expect(queued.kind).toBe('queued')
    if (queued.kind !== 'queued') return

    let current = replaceCanvasSnapshot(queued.snapshot, canvas())
    for (let index = 0; index < 256; index++) {
      current = consumeChangeSetSequence(current, `later-${index}`)
    }
    const restarted = JSON.parse(JSON.stringify(current)) as CanvasSnapshot
    expect(recentChangeSetDigest(restarted, token.sequence)).toBeUndefined()
    expect((restarted as any)[SERVER_CANVAS_METADATA_KEY].recentDigests).toHaveLength(256)
    expect(pendingChangeSetsForClient(restarted)).toEqual([{ token, changeSet }])

    const beforeRetry = JSON.stringify(restarted)
    expect(admitTokenizedChangeSet(restarted, token, changeSet, digest)).toMatchObject({
      kind: 'duplicate', payloadUnverified: true,
    })
    expectUnchanged(restarted, beforeRetry)
    expect(Object.values((restarted as any).document.store)
      .filter((record: any) => record?.props?.text === 'Pending after eviction')).toEqual([])

    const incoming = structuredClone(canvas()) as any
    incoming.document.store['shape:pending'] = {
      id: 'shape:pending', typeName: 'shape', type: 'card',
      meta: { elvesChangeSetToken: changeSetTokenStamp(token) },
      props: { kind: 'note', noteKind: 'text' },
    }
    const materialized = replaceCanvasSnapshot(
      restarted, incoming, { materializePending: true },
    )
    expect(pendingChangeSetsForClient(materialized)).toEqual([])
  })

  test('a retained consumed token rejects a different canonical payload', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const winner = move('winner', 10)
    const first = admitTokenizedChangeSet(start, token, winner, changeSetDigest(winner))
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return
    const different = move('loser', 20)
    const before = JSON.stringify(first.snapshot)

    const retry = admitTokenizedChangeSet(first.snapshot, token, different, changeSetDigest(different))
    expect(retry).toMatchObject({ kind: 'conflict', code: 'sequence-payload-mismatch' })
    expectUnchanged(first.snapshot, before)
  })

  test('a wrong epoch is rejected without consuming the current sequence', () => {
    const start = ready()
    const before = JSON.stringify(start)
    const result = admitTokenizedChangeSet(
      start,
      { epoch: 'wrong', sequence: 0 },
      create('wrong-epoch'),
      changeSetDigest(create('wrong-epoch')),
    )
    expect(result).toMatchObject({ kind: 'conflict', code: 'epoch-mismatch' })
    expect(nextChangeSetToken(start).sequence).toBe(0)
    expectUnchanged(start, before)
  })

  test('a future sequence is rejected without consuming the current sequence', () => {
    const start = ready()
    const current = nextChangeSetToken(start)
    const before = JSON.stringify(start)
    const changeSet = create('future')
    const result = admitTokenizedChangeSet(
      start,
      { ...current, sequence: current.sequence + 1 },
      changeSet,
      changeSetDigest(changeSet),
    )
    expect(result).toMatchObject({ kind: 'conflict', code: 'sequence-ahead' })
    expectUnchanged(start, before)
  })

  test('two producer decisions over one token admit only the shared-current winner', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const winner = move('winner', 10)
    const loser = move('loser', 20)
    const accepted = admitTokenizedChangeSet(start, token, winner, changeSetDigest(winner))
    expect(accepted.kind).toBe('applied')
    if (accepted.kind !== 'applied') return

    const rejected = admitTokenizedChangeSet(
      accepted.snapshot,
      token,
      loser,
      changeSetDigest(loser),
    )
    expect(rejected).toMatchObject({ kind: 'conflict', code: 'sequence-payload-mismatch' })
    expect((accepted.snapshot as any).document.store['shape:a'].x).toBe(10)
  })

  test('sequence exhaustion returns an explicit no-mutation result', () => {
    const start = ready()
    const atLimit = structuredClone(start)
    ;(atLimit as any)[SERVER_CANVAS_METADATA_KEY].nextSequence = Number.MAX_SAFE_INTEGER
    const before = JSON.stringify(atLimit)
    const changeSet = create('sequence-exhausted')
    const result = admitTokenizedChangeSet(
      atLimit,
      nextChangeSetToken(atLimit),
      changeSet,
      changeSetDigest(changeSet),
    )
    expect(result).toMatchObject({ kind: 'exhausted', code: 'changeset-sequence-exhausted' })
    expectUnchanged(atLimit, before)
  })

  test('revision exhaustion returns an explicit no-mutation result', () => {
    const start = ready()
    const atLimit = structuredClone(start)
    ;(atLimit as any)[SERVER_CANVAS_METADATA_KEY].revision = Number.MAX_SAFE_INTEGER
    const before = JSON.stringify(atLimit)
    const changeSet = create('revision-exhausted')
    const result = admitCurrent(atLimit, changeSet)
    expect(result).toMatchObject({ kind: 'exhausted', code: 'canvas-revision-exhausted' })
    expectUnchanged(atLimit, before)
  })

  test('invalid card, section, group, and question references do not consume a token', () => {
    const cases: ChangeSet[] = [
      { id: 'card', author: 'claude', ops: [{ kind: 'delete_card', cardId: 'shape:missing' }] },
      { id: 'section', author: 'claude', ops: [{ kind: 'edit_section_text', sectionId: 'shape:missing', text: 'x' }] },
      { id: 'group', author: 'claude', ops: [{ kind: 'ungroup_cards', groupId: 'shape:missing' }] },
      {
        id: 'question', author: 'claude',
        ops: [{
          kind: 'set_question_summary', questionId: 'shape:missing', summary: 'x',
          summaryOfHash: 'h', summaryBy: 'm', summaryAt: 'T',
        }],
      },
    ]
    for (const changeSet of cases) {
      const start = ready()
      const result = admitCurrent(start, changeSet)
      expect(result).toMatchObject({ kind: 'invalid-target', missing: ['shape:missing'] })
      expect(canvasRevision(start)).toBe(0)
      expect(nextChangeSetToken(start).sequence).toBe(0)
    }
  })

  test('an invalid merge representative does not consume a token', () => {
    const start = ready()
    const changeSet: ChangeSet = {
      id: 'invalid-merge', author: 'claude',
      ops: [{ kind: 'merge_notes', cardIds: ['shape:prose', 'shape:a'] }],
    }
    const result = admitCurrent(start, changeSet)
    expect(result).toMatchObject({
      kind: 'invalid-target', missing: [], invalidMergeReps: ['shape:prose'],
    })
    expect(nextChangeSetToken(start).sequence).toBe(0)
  })

  test('a missing comment target is invalid and does not consume its token', () => {
    const start = ready()
    const before = JSON.stringify(start)
    const result = admitCurrent(start, summarizeComment('missing-comment'))
    expect(result).toMatchObject({
      kind: 'invalid-target', missing: ['comment:target'], invalidMergeReps: [],
    })
    expect(canvasRevision(start)).toBe(0)
    expect(nextChangeSetToken(start).sequence).toBe(0)
    expectUnchanged(start, before)
  })

  test('a matching comment id on another card does not satisfy the specified card target', () => {
    const start = ready()
    addComment(start, 'shape:b')
    const before = JSON.stringify(start)
    const result = admitCurrent(start, summarizeComment('wrong-card'))
    expect(result).toMatchObject({ kind: 'invalid-target', missing: ['comment:target'] })
    expect(nextChangeSetToken(start).sequence).toBe(0)
    expectUnchanged(start, before)
  })

  test('a rejected comment-summary token remains retryable after that card gains the comment', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const changeSet = summarizeComment('retry-comment')
    const digest = changeSetDigest(changeSet)
    expect(admitTokenizedChangeSet(start, token, changeSet, digest))
      .toMatchObject({ kind: 'invalid-target', missing: ['comment:target'] })

    const withComment = structuredClone(start)
    addComment(withComment, 'shape:a')
    const saved = incrementCanvasRevision(withComment)
    const result = admitTokenizedChangeSet(saved, token, changeSet, digest)
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    const comment = (result.snapshot as any).document.store['shape:a'].props.comments[0]
    expect(comment.summary).toBe('Summary')
    expect(canvasRevision(result.snapshot)).toBe(2)
    expect(nextChangeSetToken(result.snapshot).sequence).toBe(1)
  })

  test('key/id mismatches invalidate card, section, group, and question targets for both protocols', () => {
    const cases: Array<{ key: string; mismatchedKey: string; changeSet: ChangeSet }> = [
      {
        key: 'shape:a', mismatchedKey: 'record:card',
        changeSet: move('mismatched-card', 25),
      },
      {
        key: 'shape:section', mismatchedKey: 'record:section',
        changeSet: {
          id: 'mismatched-section', author: 'claude',
          ops: [{ kind: 'edit_section_text', sectionId: 'shape:section', text: 'New' }],
        },
      },
      {
        key: 'shape:group', mismatchedKey: 'record:group',
        changeSet: {
          id: 'mismatched-group', author: 'claude',
          ops: [{ kind: 'ungroup_cards', groupId: 'shape:group' }],
        },
      },
      {
        key: 'shape:question', mismatchedKey: 'record:question',
        changeSet: {
          id: 'mismatched-question', author: 'claude',
          ops: [{
            kind: 'set_question_summary', questionId: 'shape:question', summary: 'Summary',
            summaryOfHash: 'hash', summaryBy: 'model', summaryAt: 'T',
          }],
        },
      },
    ]
    for (const { key, mismatchedKey, changeSet } of cases) {
      const start = ready()
      const store = (start as any).document.store
      store[mismatchedKey] = store[key]
      delete store[key]
      expectInvalidForTokenizedAndLegacy(start, changeSet, { missing: [key] })
    }
  })

  test('a cross-type duplicate globally invalidates the target and merge representative', () => {
    const start = ready()
    ;(start as any).document.store['record:collision'] = {
      id: 'shape:a', typeName: 'shape', type: 'section', props: { text: 'Collision' },
    }
    expectInvalidForTokenizedAndLegacy(start, move('global-collision', 25), {
      missing: ['shape:a'],
    })

    const merge: ChangeSet = {
      id: 'collision-merge', author: 'claude',
      ops: [{ kind: 'merge_notes', cardIds: ['shape:a', 'shape:b'] }],
    }
    expectInvalidForTokenizedAndLegacy(start, merge, {
      missing: ['shape:a'], invalidMergeReps: ['shape:a'],
    })
  })

  test('duplicate comment ids on one addressable card are invalid for both protocols', () => {
    const start = ready()
    addComment(start, 'shape:a')
    addComment(start, 'shape:a')
    const changeSet = summarizeComment('duplicate-comment')
    expectInvalidForTokenizedAndLegacy(start, changeSet, { missing: ['comment:target'] })
  })

  test('one invalid target rejects a mixed batch without applying its valid operation', () => {
    const start = ready()
    const store = (start as any).document.store
    store['record:collision'] = {
      id: 'shape:b', typeName: 'shape', type: 'section', props: { text: 'Collision' },
    }
    const changeSet: ChangeSet = {
      id: 'mixed-invalid', author: 'claude',
      ops: [{
        kind: 'move_cards',
        moves: [{ cardId: 'shape:a', x: 25, y: 0 }, { cardId: 'shape:b', x: 50, y: 0 }],
      }],
    }
    expectInvalidForTokenizedAndLegacy(start, changeSet, { missing: ['shape:b'] })
    expect((start as any).document.store['shape:a'].x).toBe(0)
  })

  test('an unrelated global collision does not block a valid addressable target', () => {
    const start = ready()
    const store = (start as any).document.store
    store['record:collision-a'] = {
      id: 'shape:collision', typeName: 'shape', type: 'section', props: { text: 'One' },
    }
    store['record:collision-b'] = {
      id: 'shape:collision', typeName: 'shape', type: 'group', props: {},
    }
    const changeSet = move('valid-amid-collision', 25)

    const tokenized = admitCurrent(start, changeSet)
    expect(tokenized.kind).toBe('applied')
    if (tokenized.kind === 'applied') {
      expect((tokenized.snapshot as any).document.store['shape:a'].x).toBe(25)
      expect(nextChangeSetToken(tokenized.snapshot).sequence).toBe(1)
    }
    const legacy = admitLegacyChangeSet(start, changeSet, changeSetDigest(changeSet))
    expect(legacy.kind).toBe('applied')
    if (legacy.kind === 'applied') {
      expect((legacy.snapshot as any).document.store['shape:a'].x).toBe(25)
      expect(legacyChangeSetReceipt(legacy.snapshot, changeSet.id)).toBe(changeSetDigest(changeSet))
    }
  })

  test('a successful destructive operation retries as a duplicate before target validation', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const changeSet: ChangeSet = {
      id: 'delete-once', author: 'claude', ops: [{ kind: 'delete_card', cardId: 'shape:a' }],
    }
    const first = admitTokenizedChangeSet(start, token, changeSet, changeSetDigest(changeSet))
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return
    expect((first.snapshot as any).document.store['shape:a']).toBeUndefined()

    const retry = admitTokenizedChangeSet(first.snapshot, token, changeSet, changeSetDigest(changeSet))
    expect(retry).toMatchObject({ kind: 'duplicate', payloadUnverified: false })
  })

  test('one returned snapshot contains both the mutation and consumed watermark', () => {
    const start = ready()
    const before = JSON.stringify(start)
    const token = nextChangeSetToken(start)
    const changeSet = create('atomic')
    const digest = changeSetDigest(changeSet)
    const result = admitTokenizedChangeSet(start, token, changeSet, digest)
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    const created = Object.values((result.snapshot as any).document.store)
      .find((record: any) => record?.props?.text === 'atomic') as any
    expect(created.meta.elvesChangeSetToken).toBe(`${token.epoch}:${token.sequence}`)
    expect(canvasRevision(result.snapshot)).toBe(1)
    expect(nextChangeSetToken(result.snapshot).sequence).toBe(1)
    expect(recentChangeSetDigest(result.snapshot, token.sequence)).toBe(digest)
    expectUnchanged(start, before)
  })

  test('every accepted create record carries the stable token stamp', () => {
    const start = ready()
    const token = nextChangeSetToken(start)
    const changeSet: ChangeSet = {
      id: 'all-creates', author: 'claude',
      ops: [
        { kind: 'create_note_card', text: 'Stamped note', x: 0, y: 700 },
        { kind: 'create_section', text: 'Stamped section', x: 300, y: 700 },
        { kind: 'create_figure_card', title: 'Stamped figure', description: 'Plan', x: 600, y: 700 },
        { kind: 'create_question', text: 'Stamped question?', x: 900, y: 700 },
        {
          kind: 'create_reference', x: 1_200, y: 700,
          reference: {
            url: 'https://example.com', refType: 'link', title: 'Stamped reference', authors: [],
            siteName: 'Example', year: 2026, venue: null, description: null,
            faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
            fetchedBy: 'claude', fetchedAt: 'T',
          },
        },
      ],
    }
    const result = admitTokenizedChangeSet(start, token, changeSet, changeSetDigest(changeSet))
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    const stamp = `${token.epoch}:${token.sequence}`
    const stamped = Object.values((result.snapshot as any).document.store)
      .filter((record: any) => record?.meta?.elvesChangeSetToken === stamp)
    expect(stamped).toHaveLength(5)
  })
})

describe('no-document tokenized admission', () => {
  test('a create-only change set is queued and consumes its token atomically', () => {
    const start = empty()
    const changeSet: ChangeSet = {
      id: 'bootstrap', author: 'claude',
      ops: [
        { kind: 'create_note_card', text: 'Note', x: 0, y: 0 },
        { kind: 'create_section', text: 'Section', x: 0, y: 200 },
        { kind: 'create_figure_card', title: 'Figure', description: 'Plan', x: 0, y: 400 },
        { kind: 'create_question', text: 'Question?', x: 0, y: 600 },
        {
          kind: 'create_reference', x: 0, y: 800,
          reference: {
            url: 'https://example.com', refType: 'link', title: 'Example', authors: [],
            siteName: 'Example', year: 2026, venue: null, description: null,
            faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
            fetchedBy: 'claude', fetchedAt: 'T',
          },
        },
      ],
    }
    const result = admitCurrent(start, changeSet)
    expect(result.kind).toBe('queued')
    if (result.kind !== 'queued') return
    expect(canvasRevision(result.snapshot)).toBe(1)
    expect(nextChangeSetToken(result.snapshot).sequence).toBe(1)
    expect(pendingChangeSetsForClient(result.snapshot)).toEqual([{
      token: nextChangeSetToken(start), changeSet,
    }])
  })

  test('the 32-entry pending cap rejects without consuming the next token', () => {
    let current = empty()
    for (let index = 0; index < MAX_PENDING_CHANGE_SETS; index++) {
      const result = admitCurrent(current, create(`pending-${index}`))
      expect(result.kind).toBe('queued')
      if (result.kind === 'queued') current = result.snapshot
    }
    const before = JSON.stringify(current)
    const overflow = admitCurrent(current, create('overflow'))
    expect(overflow).toMatchObject({ kind: 'unavailable', code: 'pending-full' })
    expectUnchanged(current, before)
  })

  test('the 4 MB pending aggregate rejects without consuming the next token', () => {
    let current = empty()
    for (let index = 0; index < 4; index++) {
      const base = create(`million-${index}`, '')
      const overhead = Buffer.byteLength(semanticChangeSetJson(base), 'utf8')
      const exact = create(`million-${index}`, 'x'.repeat(1_000_000 - overhead))
      const result = admitCurrent(current, exact)
      expect(result.kind).toBe('queued')
      if (result.kind === 'queued') current = result.snapshot
    }
    const before = JSON.stringify(current)
    const overflow = admitCurrent(current, create('overflow-byte', 'x'))
    expect(overflow).toMatchObject({ kind: 'unavailable', code: 'pending-too-large' })
    expectUnchanged(current, before)
  })

  test('a non-create-only change set is not queued or consumed', () => {
    const start = empty()
    const before = JSON.stringify(start)
    const result = admitCurrent(start, { id: 'empty', author: 'claude', ops: [] })
    expect(result).toMatchObject({ kind: 'unavailable', code: 'no-document' })
    expect(pendingChangeSetsForClient(start)).toEqual([])
    expectUnchanged(start, before)
  })
})

describe('legacy admission compatibility', () => {
  test('legacy receipts are FIFO-bounded at 256 and retained retries are diagnostic', () => {
    let current = canvas()
    for (let index = 0; index <= MAX_LEGACY_CHANGE_SET_RECEIPTS; index++) {
      const changeSet = move(`legacy-${index}`, index)
      const result = admitLegacyChangeSet(current, changeSet, changeSetDigest(changeSet))
      expect(result.kind).toBe('applied')
      if (result.kind === 'applied') current = result.snapshot
    }
    expect(legacyChangeSetReceipt(current, 'legacy-0')).toBeUndefined()
    expect(legacyChangeSetReceipt(current, 'legacy-256')).toBe(
      changeSetDigest(move('legacy-256', 256)),
    )

    const retained = move('legacy-256', 256)
    expect(admitLegacyChangeSet(current, retained, changeSetDigest(retained)))
      .toMatchObject({ kind: 'duplicate' })
    const mismatched = move('legacy-256', 999)
    expect(admitLegacyChangeSet(current, mismatched, changeSetDigest(mismatched)))
      .toMatchObject({ kind: 'conflict', code: 'changeset-id-conflict' })

    const evicted = move('legacy-0', 999)
    expect(admitLegacyChangeSet(current, evicted, changeSetDigest(evicted)))
      .toMatchObject({ kind: 'applied' })
  })

  test('a destructive legacy operation retries from its receipt before target validation', () => {
    const start = canvas()
    const changeSet: ChangeSet = {
      id: 'legacy-delete', author: 'claude', ops: [{ kind: 'delete_card', cardId: 'shape:a' }],
    }
    const first = admitLegacyChangeSet(start, changeSet, changeSetDigest(changeSet))
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied') return
    const retry = admitLegacyChangeSet(first.snapshot, changeSet, changeSetDigest(changeSet))
    expect(retry).toMatchObject({ kind: 'duplicate' })
  })

  test('legacy invalid targets leave the snapshot and receipt state unchanged', () => {
    const start = canvas()
    const before = JSON.stringify(start)
    const changeSet: ChangeSet = {
      id: 'legacy-missing', author: 'claude', ops: [{ kind: 'delete_card', cardId: 'missing' }],
    }
    const result = admitLegacyChangeSet(start, changeSet, changeSetDigest(changeSet))
    expect(result).toMatchObject({ kind: 'invalid-target', missing: ['missing'] })
    expect(legacyChangeSetReceipt(start, changeSet.id)).toBeUndefined()
    expectUnchanged(start, before)
  })

  test('legacy comment summaries require the comment on the specified card', () => {
    const start = canvas()
    addComment(start, 'shape:b')
    const changeSet = summarizeComment('legacy-comment')
    const digest = changeSetDigest(changeSet)
    const before = JSON.stringify(start)
    expect(admitLegacyChangeSet(start, changeSet, digest))
      .toMatchObject({ kind: 'invalid-target', missing: ['comment:target'] })
    expectUnchanged(start, before)

    addComment(start, 'shape:a')
    const result = admitLegacyChangeSet(start, changeSet, digest)
    expect(result.kind).toBe('applied')
    if (result.kind !== 'applied') return
    const comment = (result.snapshot as any).document.store['shape:a'].props.comments[0]
    expect(comment.summary).toBe('Summary')
    expect(legacyChangeSetReceipt(result.snapshot, changeSet.id)).toBe(digest)
  })

  test('legacy no-document work remains unapplied and records no receipt', () => {
    const start: CanvasSnapshot = { document: null, session: null }
    const before = JSON.stringify(start)
    const changeSet = create('legacy-bootstrap')
    const result = admitLegacyChangeSet(start, changeSet, changeSetDigest(changeSet))
    expect(result).toMatchObject({ kind: 'unapplied', reason: 'no-document' })
    expect(legacyChangeSetReceipt(start, changeSet.id)).toBeUndefined()
    expectUnchanged(start, before)
  })

  test('legacy revision exhaustion is explicit and leaves receipt state unchanged', () => {
    const start = ready()
    const atLimit = structuredClone(start)
    ;(atLimit as any)[SERVER_CANVAS_METADATA_KEY].revision = Number.MAX_SAFE_INTEGER
    const before = JSON.stringify(atLimit)
    const changeSet = move('legacy-exhausted', 10)
    const result = admitLegacyChangeSet(atLimit, changeSet, changeSetDigest(changeSet))
    expect(result).toMatchObject({ kind: 'exhausted', code: 'canvas-revision-exhausted' })
    expect(legacyChangeSetReceipt(atLimit, changeSet.id)).toBeUndefined()
    expectUnchanged(atLimit, before)
  })
})
