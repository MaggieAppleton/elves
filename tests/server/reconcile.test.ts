import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import { createProject, canvasPathFor, renameProject } from '../../server/projects'
import {
  reconcileSummaries, reconcileCommentSummaries, reconcileQuestionSummaries,
  type ReconcileCard, type ReconcileComment, type ReconcileQuestion,
} from '../../server/summarize/reconcile'
import { reconcileCanvasFile } from '../../server/summarize/runner'
import type { Summarizer } from '../../server/summarize'
import { summaryHash } from '../../src/model/summary'
import { applyChangeSetToSnapshot } from '../../server/applyChangeSet'
import { CHANGE_SET_STAMP_META_KEY, type ChangeSet } from '../../src/model/changeset'
import type { Reference } from '../../src/model/types'
import {
  CanvasRevisionExhaustedError,
  SERVER_CANVAS_METADATA_KEY,
  canvasRevision,
  ensureCanvasMetadata,
  replaceCanvasSnapshot,
} from '../../server/canvasMetadata'
import { withProjectLock } from '../../server/projectLock'
import { withCanvasLock } from '../../server/store'

const LONG = 'A '.repeat(120) + 'the end.'

const STAMP_REFERENCE: Reference = {
  url: 'https://example.com', refType: 'link', title: 'Example', authors: [],
  siteName: 'example.com', year: null, venue: null, description: null,
  faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
  fetchedBy: 'claude', fetchedAt: '2026-07-13T00:00:00.000Z',
}

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

// --- Questions: the same reconciliation, addressed by the question's own id -

function question(over: Partial<ReconcileQuestion> = {}): ReconcileQuestion {
  return { questionId: 'q1', text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('reconcile generates a set_question_summary for a question with no summary', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileQuestionSummaries([question()], fake, () => 'T')
  expect(fake.calls).toEqual([LONG])
  expect(cs?.ops).toEqual([
    { kind: 'set_question_summary', questionId: 'q1', summary: 'a gist', summaryOfHash: summaryHash(LONG), summaryBy: 'fake/test', summaryAt: 'T' },
  ])
})

test('reconcile is a no-op for an up-to-date question', async () => {
  const fake = new FakeSummarizer()
  const cs = await reconcileQuestionSummaries(
    [question({ summary: 'g', summaryOfHash: summaryHash(LONG) })], fake, () => 'T',
  )
  expect(fake.calls).toEqual([])
  expect(cs).toBeNull()
})

test('applyChangeSetToSnapshot persists a set_question_summary onto the question record', () => {
  const snapshot = {
    document: { store: {
      'shape:q1': { id: 'shape:q1', typeName: 'shape', type: 'question', props: {
        w: 370, h: 96, text: 'a long question?', authoredBy: 'claude', dismissed: false,
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      } },
    } },
  }
  const next = applyChangeSetToSnapshot(snapshot as never, {
    id: 's', author: 'claude',
    ops: [{ kind: 'set_question_summary', questionId: 'shape:q1', summary: 'gist', summaryOfHash: 'h', summaryBy: 'b', summaryAt: 'T' }],
  })
  const q = (next as any).document.store['shape:q1']
  expect(q.props.summary).toBe('gist')
  expect(q.props.summaryOfHash).toBe('h')
})

test('snapshot apply stamps all five queueable create record kinds, and legacy apply does not', () => {
  const base = { document: { store: { 'page:page': { id: 'page:page', typeName: 'page' } } } }
  const changeSet: ChangeSet = {
    id: 'all-create-kinds', author: 'claude',
    ops: [
      { kind: 'create_note_card', text: 'Note', x: 0, y: 0 },
      { kind: 'create_reference', reference: STAMP_REFERENCE, x: 300, y: 0 },
      { kind: 'create_figure_card', title: 'Figure', description: 'Plan', x: 600, y: 0 },
      { kind: 'create_section', text: 'Section', x: 900, y: 0 },
      { kind: 'create_question', text: 'Question?', x: 1_200, y: 0 },
    ],
  }
  const stamp = 'epoch-a:7'
  const stamped = applyChangeSetToSnapshot(base as never, changeSet, stamp) as any
  const stampedCreates = Object.values(stamped.document.store)
    .filter((record: any) => record?.typeName === 'shape') as any[]
  expect(stampedCreates).toHaveLength(5)
  expect(stampedCreates.map((record) => record.meta?.[CHANGE_SET_STAMP_META_KEY]))
    .toEqual(Array(5).fill(stamp))

  const legacy = applyChangeSetToSnapshot(base as never, changeSet) as any
  const legacyCreates = Object.values(legacy.document.store)
    .filter((record: any) => record?.typeName === 'shape') as any[]
  expect(legacyCreates.map((record) => record.meta?.[CHANGE_SET_STAMP_META_KEY]))
    .toEqual(Array(5).fill(undefined))
})

// --- Integration: the server wires reconcile into a canvas save --------------

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

/** A temp project with an on-disk canvas.json holding one long, unsummarized
 * card — reconcileCanvasFile's own file-driven entry point, as opposed to the
 * pure reconcileSummaries tests above which pass in-memory card arrays. */
async function seedCanvasWithLongCard(): Promise<{ dataRoot: string; canvasPath: string }> {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')
  const canvasPath = canvasPathFor(d, 'essay')!
  const snap = ensureCanvasMetadata({
    document: { store: { 'shape:a': {
      id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: LONG, comments: [], mergedInto: null },
    } } },
    session: null,
  }).snapshot
  await fs.writeFile(canvasPath, JSON.stringify(snap), 'utf8')
  return { dataRoot: d, canvasPath }
}

async function seedSummaryCanvas(store: Record<string, unknown>) {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')
  const canvasPath = canvasPathFor(d, 'essay')!
  const snapshot = ensureCanvasMetadata({ document: { store }, session: null }).snapshot
  await fs.writeFile(canvasPath, JSON.stringify(snapshot), 'utf8')
  return { dataRoot: d, canvasPath }
}

async function acceptedCanvasMutation(
  dataRoot: string,
  mutate: (snapshot: any) => void,
): Promise<void> {
  await withProjectLock(dataRoot, 'essay', async () => {
    const path = canvasPathFor(dataRoot, 'essay')!
    await withCanvasLock(path, (current) => {
      const incoming = structuredClone(current)
      mutate(incoming)
      return replaceCanvasSnapshot(current, incoming)
    })
  })
}

function delayedSummary() {
  let started!: () => void
  let release!: (summary: string | null) => void
  const didStart = new Promise<void>((resolve) => { started = resolve })
  const reply = new Promise<string | null>((resolve) => { release = resolve })
  const summarizer: Summarizer = {
    label: 'delayed/test',
    summarize: async () => {
      started()
      return reply
    },
  }
  return { summarizer, didStart, release }
}

function summaryCard(id: string, text: string, comments: any[] = []) {
  return {
    id, typeName: 'shape', type: 'card', x: 0, y: 0,
    props: {
      w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text,
      comments, mergedInto: null, summary: null, summaryOfHash: null,
      summaryBy: null, summaryAt: null,
    },
  }
}

function summaryQuestion(id: string, text: string) {
  return {
    id, typeName: 'shape', type: 'question', x: 0, y: 0,
    props: {
      w: 370, h: 96, text, authoredBy: 'claude', dismissed: false,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    },
  }
}

function summaryComment(id: string, text: string) {
  return {
    id, type: null, text, resolved: false, author: 'claude',
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
}

test('reconcileCanvasFile reports pending when the summarizer is unreachable', async () => {
  const { dataRoot, canvasPath } = await seedCanvasWithLongCard()
  const down = new FakeSummarizer(() => null)
  const r1 = await reconcileCanvasFile(dataRoot, 'essay', down, () => 'T')
  expect(r1.changeSet).toBeNull()
  expect(r1.pending).toBe(true)

  const up = new FakeSummarizer(() => 'a gist')
  const r2 = await reconcileCanvasFile(dataRoot, 'essay', up, () => 'T')
  expect(r2.changeSet?.ops.length).toBeGreaterThan(0)
  expect(r2.pending).toBe(false)
  expect(canvasRevision(JSON.parse(await fs.readFile(canvasPath, 'utf8')))).toBe(1)
})

test.each([
  {
    label: 'card text',
    store: { 'shape:a': summaryCard('shape:a', LONG) },
    mutate: (snapshot: any) => { snapshot.document.store['shape:a'].props.text = `${LONG} changed` },
  },
  {
    label: 'card summary state',
    store: { 'shape:a': summaryCard('shape:a', LONG) },
    mutate: (snapshot: any) => {
      snapshot.document.store['shape:a'].props.summary = 'already filled'
      snapshot.document.store['shape:a'].props.summaryOfHash = summaryHash(LONG)
    },
  },
  {
    label: 'comment text',
    store: {
      'shape:a': summaryCard('shape:a', '', [{
        id: 'cmt-1', type: null, text: LONG, resolved: false, author: 'claude',
        summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
      }]),
    },
    mutate: (snapshot: any) => {
      snapshot.document.store['shape:a'].props.comments[0].text = `${LONG} changed`
    },
  },
  {
    label: 'question text',
    store: { 'shape:q1': summaryQuestion('shape:q1', LONG) },
    mutate: (snapshot: any) => { snapshot.document.store['shape:q1'].props.text = `${LONG} changed` },
  },
  {
    label: 'missing target',
    store: { 'shape:a': summaryCard('shape:a', LONG) },
    mutate: (snapshot: any) => { delete snapshot.document.store['shape:a'] },
  },
])('stale $label result is discarded without a second write', async ({ store, mutate }) => {
  const { dataRoot, canvasPath } = await seedSummaryCanvas(store)
  const delayed = delayedSummary()
  const run = reconcileCanvasFile(dataRoot, 'essay', delayed.summarizer, () => 'T')
  await delayed.didStart
  await acceptedCanvasMutation(dataRoot, mutate)
  const afterAccepted = await fs.readFile(canvasPath)
  const backupAfterAccepted = await fs.readFile(`${canvasPath}.bak`)

  delayed.release('stale gist')
  const result = await run

  expect(result).toEqual({ changeSet: null, pending: true })
  expect(await fs.readFile(canvasPath)).toEqual(afterAccepted)
  expect(await fs.readFile(`${canvasPath}.bak`)).toEqual(backupAfterAccepted)
  expect(canvasRevision(JSON.parse(afterAccepted.toString()))).toBe(1)
})

test('fresh subset applies once over a concurrent save while stale work remains pending', async () => {
  const firstText = `${LONG} first`
  const secondText = `${LONG} second`
  const { dataRoot, canvasPath } = await seedSummaryCanvas({
    'shape:a': summaryCard('shape:a', firstText),
    'shape:b': summaryCard('shape:b', secondText),
  })
  let secondStarted!: () => void
  let releaseSecond!: (summary: string | null) => void
  const didStartSecond = new Promise<void>((resolve) => { secondStarted = resolve })
  const secondReply = new Promise<string | null>((resolve) => { releaseSecond = resolve })
  const summarizer: Summarizer = {
    label: 'partial/test',
    summarize: async (text) => {
      if (text === firstText) return 'first gist'
      secondStarted()
      return secondReply
    },
  }
  const run = reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T')
  await didStartSecond
  await acceptedCanvasMutation(dataRoot, (snapshot) => {
    snapshot.document.store['shape:b'].props.text = `${secondText} changed`
    snapshot.session = { selected: ['shape:b'] }
  })
  releaseSecond('stale second gist')

  const result = await run
  const stored = JSON.parse(await fs.readFile(canvasPath, 'utf8'))
  expect(result.pending).toBe(true)
  expect(result.changeSet?.ops).toEqual([
    expect.objectContaining({ kind: 'set_summary', cardId: 'shape:a', summary: 'first gist' }),
  ])
  expect(stored.document.store['shape:a'].props.summary).toBe('first gist')
  expect(stored.document.store['shape:b'].props).toMatchObject({
    text: `${secondText} changed`, summary: null,
  })
  expect(stored.session).toEqual({ selected: ['shape:b'] })
  expect(canvasRevision(stored)).toBe(2)
})

test('summary revision exhaustion fails closed without persisting the generated result', async () => {
  const { dataRoot, canvasPath } = await seedCanvasWithLongCard()
  const current = JSON.parse(await fs.readFile(canvasPath, 'utf8'))
  current[SERVER_CANVAS_METADATA_KEY].revision = Number.MAX_SAFE_INTEGER
  await fs.writeFile(canvasPath, JSON.stringify(current), 'utf8')
  const before = await fs.readFile(canvasPath)

  await expect(reconcileCanvasFile(
    dataRoot, 'essay', new FakeSummarizer(() => 'gist'), () => 'T',
  )).rejects.toBeInstanceOf(CanvasRevisionExhaustedError)
  expect(await fs.readFile(canvasPath)).toEqual(before)
  await expect(fs.access(`${canvasPath}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a no-document reconcile is byte-stable and produces no change-set', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')
  const canvasPath = canvasPathFor(d, 'essay')!
  const snapshot = ensureCanvasMetadata({ document: null, session: null }).snapshot
  await fs.writeFile(canvasPath, JSON.stringify(snapshot), 'utf8')
  const before = await fs.readFile(canvasPath)

  const result = await reconcileCanvasFile(d, 'essay', new FakeSummarizer(), () => 'T')

  expect(result).toEqual({ changeSet: null, pending: false })
  expect(await fs.readFile(canvasPath)).toEqual(before)
  await expect(fs.access(`${canvasPath}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([
  {
    label: 'comments',
    store: {
      'shape:a': summaryCard('shape:a', '', [
        summaryComment('cmt-duplicate', `${LONG} first`),
        summaryComment('cmt-duplicate', `${LONG} second`),
      ]),
    },
  },
  {
    label: 'cards',
    store: {
      'record:a': summaryCard('shape:duplicate', `${LONG} first`),
      'record:b': summaryCard('shape:duplicate', `${LONG} second`),
    },
  },
  {
    label: 'questions',
    store: {
      'record:q1': summaryQuestion('shape:duplicate', `${LONG} first`),
      'record:q2': summaryQuestion('shape:duplicate', `${LONG} second`),
    },
  },
])('ambiguous duplicate $label never call the model, write, or become pending', async ({ store }) => {
  const { dataRoot, canvasPath } = await seedSummaryCanvas(store)
  const summarizer = new FakeSummarizer()
  const before = await fs.readFile(canvasPath)

  const first = await reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T')
  const second = await reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T')

  expect(first).toEqual({ changeSet: null, pending: false })
  expect(second).toEqual({ changeSet: null, pending: false })
  expect(summarizer.calls).toEqual([])
  expect(await fs.readFile(canvasPath)).toEqual(before)
  expect(canvasRevision(JSON.parse(before.toString()))).toBe(0)
  await expect(fs.access(`${canvasPath}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a mixed canvas summarizes only unique targets and leaves duplicates inert', async () => {
  const duplicateOne = `${LONG} duplicate one`
  const duplicateTwo = `${LONG} duplicate two`
  const uniqueText = `${LONG} unique`
  const { dataRoot, canvasPath } = await seedSummaryCanvas({
    'shape:a': summaryCard('shape:a', '', [
      summaryComment('cmt-duplicate', duplicateOne),
      summaryComment('cmt-duplicate', duplicateTwo),
      summaryComment('cmt-unique', uniqueText),
    ]),
  })
  const summarizer = new FakeSummarizer((text) => `gist for ${text.slice(-6)}`)

  const result = await reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T')
  const stored = JSON.parse(await fs.readFile(canvasPath, 'utf8'))

  expect(summarizer.calls).toEqual([uniqueText])
  expect(result.pending).toBe(false)
  expect(result.changeSet?.ops).toEqual([
    expect.objectContaining({
      kind: 'set_comment_summary', cardId: 'shape:a', commentId: 'cmt-unique',
    }),
  ])
  expect(stored.document.store['shape:a'].props.comments
    .filter((entry: any) => entry.id === 'cmt-duplicate')
    .map((entry: any) => entry.summary)).toEqual([null, null])
  expect(stored.document.store['shape:a'].props.comments
    .find((entry: any) => entry.id === 'cmt-unique').summary).toBe('gist for unique')
  expect(canvasRevision(stored)).toBe(1)
})

test('repairing duplicate comment ids allows a later run to summarize once', async () => {
  const repairedText = `${LONG} repaired`
  const { dataRoot, canvasPath } = await seedSummaryCanvas({
    'shape:a': summaryCard('shape:a', '', [
      summaryComment('cmt-duplicate', repairedText),
      summaryComment('cmt-duplicate', `${LONG} remove me`),
    ]),
  })
  const summarizer = new FakeSummarizer()
  expect(await reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T'))
    .toEqual({ changeSet: null, pending: false })
  expect(summarizer.calls).toEqual([])

  await acceptedCanvasMutation(dataRoot, (snapshot) => {
    snapshot.document.store['shape:a'].props.comments.splice(1, 1)
  })
  const repaired = await reconcileCanvasFile(dataRoot, 'essay', summarizer, () => 'T')
  const stored = JSON.parse(await fs.readFile(canvasPath, 'utf8'))

  expect(summarizer.calls).toEqual([repairedText])
  expect(repaired.pending).toBe(false)
  expect(repaired.changeSet?.ops).toHaveLength(1)
  expect(stored.document.store['shape:a'].props.comments[0].summary).toBe('a gist')
  expect(canvasRevision(stored)).toBe(2)
})

test('a target duplicated during model work is discarded without retry churn', async () => {
  const text = `${LONG} initially unique`
  const { dataRoot, canvasPath } = await seedSummaryCanvas({
    'shape:a': summaryCard('shape:a', '', [summaryComment('cmt-1', text)]),
  })
  const delayed = delayedSummary()
  const run = reconcileCanvasFile(dataRoot, 'essay', delayed.summarizer, () => 'T')
  await delayed.didStart
  await acceptedCanvasMutation(dataRoot, (snapshot) => {
    snapshot.document.store['shape:a'].props.comments.push(summaryComment('cmt-1', text))
  })
  const afterDuplicate = await fs.readFile(canvasPath)
  const backupAfterDuplicate = await fs.readFile(`${canvasPath}.bak`)

  delayed.release('ambiguous gist')
  const result = await run

  expect(result).toEqual({ changeSet: null, pending: false })
  expect(await fs.readFile(canvasPath)).toEqual(afterDuplicate)
  expect(await fs.readFile(`${canvasPath}.bak`)).toEqual(backupAfterDuplicate)
  expect(canvasRevision(JSON.parse(afterDuplicate.toString()))).toBe(1)
})

test('summary apply does not recreate a project renamed during model work', async () => {
  const { dataRoot } = await seedCanvasWithLongCard()
  let start!: () => void
  let release!: (summary: string | null) => void
  const started = new Promise<void>((resolve) => { start = resolve })
  const reply = new Promise<string | null>((resolve) => { release = resolve })
  const delayed: Summarizer = {
    label: 'delayed/test',
    summarize: async () => {
      start()
      return reply
    },
  }
  const run = reconcileCanvasFile(dataRoot, 'essay', delayed, () => 'T')
  await started
  await renameProject(dataRoot, 'essay', 'Final')
  release('a gist')
  const result = await run
  expect(result.changeSet).toBeNull()
  await expect(fs.access(join(dataRoot, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
  const moved = JSON.parse(await fs.readFile(canvasPathFor(dataRoot, 'final')!, 'utf8'))
  expect(moved.document.store['shape:a'].props.summary ?? null).toBeNull()
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

test('a summary left pending is retried once the summarizer recovers', async () => {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-sum-'))
  dirs.push(d)
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')

  let up = false
  const flaky = new FakeSummarizer(() => (up ? 'a gist' : null))
  let changeSetCount = 0
  const onChangeSet = () => { changeSetCount += 1 }
  const app = createServer(d, onChangeSet, {
    summarizer: flaky, now: () => 'T', debounceMs: 1, retryBaseMs: 5, retryMaxMs: 10,
  })

  const snap = {
    document: { store: { 'shape:a': {
      id: 'shape:a', typeName: 'shape', type: 'card', x: 0, y: 0,
      props: { w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: LONG, comments: [], mergedInto: null },
    } } },
    session: null,
  }
  await request(app).post('/projects/essay/canvas').send(snap)

  // Give the debounced reconcile time to run while the summarizer is down.
  await new Promise((r) => setTimeout(r, 30))
  let cards = await request(app).post('/projects/essay/cards').send({ ids: ['shape:a'] })
  expect(cards.body.cards[0].summary).toBeNull()
  expect(flaky.calls.length).toBeGreaterThan(0)
  const callsWhileDown = flaky.calls.length

  // The summarizer recovers — no further save or restart needed.
  up = true
  await new Promise((r) => setTimeout(r, 100))

  cards = await request(app).post('/projects/essay/cards').send({ ids: ['shape:a'] })
  expect(cards.body.cards[0].summary).toBe('a gist')
  expect(changeSetCount).toBeGreaterThan(0)

  // Once filled, no further retry should fire — call count stays put.
  const callsAfterFilled = flaky.calls.length
  await new Promise((r) => setTimeout(r, 60))
  expect(flaky.calls.length).toBe(callsAfterFilled)
  expect(callsAfterFilled).toBeGreaterThan(callsWhileDown)
})
