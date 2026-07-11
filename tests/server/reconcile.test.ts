import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { createProject } from '../../server/projects'
import {
  reconcileSummaries, reconcileCommentSummaries, type ReconcileCard, type ReconcileComment,
} from '../../server/summarize/reconcile'
import type { Summarizer } from '../../server/summarize'
import { summaryHash } from '../../src/model/summary'

const LONG = 'A '.repeat(120) + 'the end.'

class FakeSummarizer implements Summarizer {
  label = 'fake/test'
  calls: string[] = []
  constructor(private reply: (t: string) => string | null = () => 'a gist') {}
  async summarize(text: string): Promise<string | null> {
    this.calls.push(text)
    return this.reply(text)
  }
}

function card(over: Partial<ReconcileCard> = {}): ReconcileCard {
  return { id: 'c1', kind: 'prose', noteKind: null, text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('reconcile generates a set_summary for a long card with no summary', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileSummaries([card()], fake, () => 'T')
  expect(fake.calls).toEqual([LONG])
  expect(cs?.author).toBe('claude')
  expect(cs?.ops).toEqual([
    { kind: 'set_summary', cardId: 'c1', summary: 'a gist', summaryOfHash: summaryHash(LONG), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile clears a stale summary when the card was emptied', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileSummaries(
    [card({ text: '   ', summary: 'stale', summaryOfHash: summaryHash(LONG) })],
    fake, () => 'T',
  )
  expect(fake.calls).toEqual([]) // no model call needed to clear
  expect(cs?.ops).toEqual([
    { kind: 'set_summary', cardId: 'c1', summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
  ])
})

test('reconcile generates for a short card too, and is a no-op for up-to-date ones', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileSummaries(
    [
      card({ id: 'short', text: 'a short note' }), // now summarized as well
      card({ id: 'current', summary: 'g', summaryOfHash: summaryHash(LONG) }),
    ],
    fake, () => 'T',
  )
  expect(fake.calls).toEqual(['a short note'])
  expect(cs?.ops).toEqual([
    { kind: 'set_summary', cardId: 'short', summary: 'a gist', summaryOfHash: summaryHash('a short note'), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile yields null when the summarizer returns nothing (e.g. Ollama down)', async () => {
  const fake = new FakeSummarizer(() => null)
  const cs = await reconcileSummaries([card()], fake, () => 'T')
  expect(cs).toBeNull()
})

// --- Comments: the same reconciliation, one level down ----------------------

function comment(over: Partial<ReconcileComment> = {}): ReconcileComment {
  return { cardId: 'c1', commentId: 'cmt-1', text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('reconcile generates a set_comment_summary for a comment with no summary', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileCommentSummaries([comment()], fake, () => 'T')
  expect(fake.calls).toEqual([LONG])
  expect(cs?.author).toBe('claude')
  expect(cs?.ops).toEqual([
    { kind: 'set_comment_summary', cardId: 'c1', commentId: 'cmt-1', summary: 'a gist', summaryOfHash: summaryHash(LONG), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile clears a stale comment summary when the comment text was emptied', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileCommentSummaries(
    [comment({ text: '   ', summary: 'stale', summaryOfHash: summaryHash(LONG) })],
    fake, () => 'T',
  )
  expect(fake.calls).toEqual([])
  expect(cs?.ops).toEqual([
    { kind: 'set_comment_summary', cardId: 'c1', commentId: 'cmt-1', summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null },
  ])
})

test('reconcile generates for a short comment too, and is a no-op for up-to-date ones', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileCommentSummaries(
    [
      comment({ commentId: 'short', text: 'a short note' }),
      comment({ commentId: 'current', summary: 'g', summaryOfHash: summaryHash(LONG) }),
    ],
    fake, () => 'T',
  )
  expect(fake.calls).toEqual(['a short note'])
  expect(cs?.ops).toEqual([
    { kind: 'set_comment_summary', cardId: 'c1', commentId: 'short', summary: 'a gist', summaryOfHash: summaryHash('a short note'), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile comment summaries yields null when the summarizer returns nothing', async () => {
  const fake = new FakeSummarizer(() => null)
  const cs = await reconcileCommentSummaries([comment()], fake, () => 'T')
  expect(cs).toBeNull()
})

// --- Integration: the server wires reconcile into a canvas save --------------

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('createServer with a summarizer broadcasts + persists a summary after a canvas save', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')

  let resolve!: (v: { pid: string; cs: any }) => void
  const got = new Promise<{ pid: string; cs: any }>((r) => { resolve = r })
  const onChangeSet = (pid: string, cs: any) => {
    if (cs.ops[0]?.kind === 'set_summary') resolve({ pid, cs })
  }
  const app = createServer(d, onChangeSet, { summarizer: new FakeSummarizer(), now: () => 'T', debounceMs: 5 })

  const snap = {
    document: { store: { 'shape:a': {
      id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: LONG, comments: [], mergedInto: null },
    } } },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)

  const { pid, cs } = await got
  expect(pid).toBe('essay')
  expect(cs.ops[0]).toMatchObject({ kind: 'set_summary', cardId: 'shape:a', summary: 'a gist', summaryBy: 'fake/test' })

  // The summary landed on disk: the drill-down now carries it.
  const cards = await request(app).post('/projects/essay/cards').send({ ids: ['shape:a'] })
  expect(cards.body.cards[0].summary).toBe('a gist')
})

test('reconcileCanvasFile summarizes a comment alongside its card in one combined change-set', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')

  let resolve!: (v: { pid: string; cs: any }) => void
  const got = new Promise<{ pid: string; cs: any }>((r) => { resolve = r })
  const onChangeSet = (pid: string, cs: any) => {
    if (cs.ops.some((op: any) => op.kind === 'set_comment_summary')) resolve({ pid, cs })
  }
  const app = createServer(d, onChangeSet, { summarizer: new FakeSummarizer(), now: () => 'T', debounceMs: 5 })

  const snap = {
    document: { store: { 'shape:a': {
      id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: {
        w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: LONG, mergedInto: null,
        comments: [{ id: 'cmt-1', type: null, text: LONG, resolved: false, author: 'claude', summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null }],
      },
    } } },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)

  const { pid, cs } = await got
  expect(pid).toBe('essay')
  // Both the card and its comment got summarized in the SAME change-set.
  expect(cs.ops).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'set_summary', cardId: 'shape:a', summary: 'a gist' }),
    expect.objectContaining({ kind: 'set_comment_summary', cardId: 'shape:a', commentId: 'cmt-1', summary: 'a gist' }),
  ]))

  const cards = await request(app).post('/projects/essay/cards').send({ ids: ['shape:a'] })
  expect(cards.body.cards[0].summary).toBe('a gist')
  expect(cards.body.cards[0].comments[0].summary).toBe('a gist')
})
