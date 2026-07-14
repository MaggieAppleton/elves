import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateSourceCardsToNotes } from '../../server/migrateNotes'
import { createProject, canvasPathFor, renameProject } from '../../server/projects'
import { withProjectLock } from '../../server/projectLock'
import {
  SERVER_CANVAS_METADATA_KEY,
  addPendingChangeSet,
  canvasRevision,
  ensureCanvasMetadata,
  nextChangeSetToken,
  pendingChangeSetsForClient,
} from '../../server/canvasMetadata'
import { changeSetDigest } from '../../server/changeSetIdentity'
import type { ChangeSet } from '../../src/model/changeset'

const lockProbe = vi.hoisted(() => {
  type Entry = { kind: 'project' | 'multi'; dataRoot: string; ids: string[] }
  const entries: Entry[] = []
  const waiters: Array<{
    predicate: (current: Entry[]) => boolean
    resolve: () => void
    reject: (error: Error) => void
    deadline: ReturnType<typeof setTimeout>
  }> = []
  return {
    record(entry: Entry) {
      entries.push(entry)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (!waiters[i].predicate(entries)) continue
        const waiter = waiters.splice(i, 1)[0]
        clearTimeout(waiter.deadline)
        waiter.resolve()
      }
    },
    waitFor(predicate: (current: Entry[]) => boolean, timeoutMs = 2_000): Promise<void> {
      if (predicate(entries)) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          deadline: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index !== -1) waiters.splice(index, 1)
            reject(new Error(`lock probe timed out after ${timeoutMs}ms`))
          }, timeoutMs),
        }
        waiters.push(waiter)
      })
    },
    reset() {
      entries.length = 0
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.deadline)
        waiter.reject(new Error('lock probe reset'))
      }
    },
  }
})

vi.mock('../../server/projectLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/projectLock')>()
  return {
    ...actual,
    withProjectLock: <T>(dataRoot: string, id: string, task: () => Promise<T>): Promise<T> => {
      const result = actual.withProjectLock(dataRoot, id, task)
      lockProbe.record({ kind: 'project', dataRoot, ids: [id] })
      return result
    },
    withProjectLocks: <T>(dataRoot: string, ids: readonly string[], task: () => Promise<T>): Promise<T> => {
      const result = actual.withProjectLocks(dataRoot, ids, task)
      lockProbe.record({ kind: 'multi', dataRoot, ids: [...ids] })
      return result
    },
  }
})

const dirs: string[] = []

async function root(): Promise<string> {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-notes-'))
  dirs.push(d)
  return d
}

async function holdProject(dataRoot: string, id: string): Promise<{
  release: () => void
  done: Promise<void>
}> {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const done = withProjectLock(dataRoot, id, async () => {
    entered()
    await gate
  })
  await started
  return { release, done }
}

afterEach(async () => {
  lockProbe.reset()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function seedSourceCanvas(d: string): Promise<string> {
  await createProject(d, 'Essay', '2026-07-02T10:00:00.000Z')
  const path = canvasPathFor(d, 'essay')!
  await fs.writeFile(path, JSON.stringify({
    document: { store: {
      'shape:a': {
        id: 'shape:a', typeName: 'shape', type: 'card',
        props: { kind: 'source', sourceKind: 'quote' },
      },
    } },
    session: null,
  }), 'utf8')
  return path
}

test('note migration waits for the project lock and transforms the current canvas', async () => {
  const d = await root()
  const path = await seedSourceCanvas(d)
  const hold = await holdProject(d, 'essay')
  lockProbe.reset()
  const migration = migrateSourceCardsToNotes(d)
  try {
    await lockProbe.waitFor((entries) => entries.some(
      (entry) => entry.kind === 'project' && entry.dataRoot === d && entry.ids[0] === 'essay',
    ))
    expect(await fs.readFile(path, 'utf8')).toContain('"kind":"source"')
  } finally {
    hold.release()
    await Promise.all([hold.done, migration])
  }
  const migrated = JSON.parse(await fs.readFile(path, 'utf8'))
  expect(migrated.document.store['shape:a'].props).toMatchObject({
    kind: 'note',
    noteKind: 'quote',
  })
  expect(migrated.document.store['shape:a'].props).not.toHaveProperty('sourceKind')
  expect(canvasRevision(migrated)).toBe(1)
})

test('note migration queued before rename transforms the canvas that is moved', async () => {
  const d = await root()
  await seedSourceCanvas(d)
  const hold = await holdProject(d, 'essay')
  let migration!: ReturnType<typeof migrateSourceCardsToNotes>
  let rename!: ReturnType<typeof renameProject>
  try {
    lockProbe.reset()
    migration = migrateSourceCardsToNotes(d)
    void migration.catch(() => undefined)
    await lockProbe.waitFor((entries) => entries.some(
      (entry) => entry.kind === 'project' && entry.dataRoot === d && entry.ids[0] === 'essay',
    ))
    rename = renameProject(d, 'essay', 'Final')
    void rename.catch(() => undefined)
    await lockProbe.waitFor((entries) => entries.some(
      (entry) => entry.kind === 'multi' && entry.dataRoot === d && entry.ids.includes('essay'),
    ))
  } finally {
    hold.release()
    await Promise.allSettled([hold.done, migration, rename])
  }
  await Promise.all([hold.done, migration, rename])
  const migrated = JSON.parse(await fs.readFile(canvasPathFor(d, 'final')!, 'utf8'))
  expect(migrated.document.store['shape:a'].props).toMatchObject({
    kind: 'note',
    noteKind: 'quote',
  })
  await expect(fs.access(join(d, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('note migration queued after rename skips the stale id without recreating it', async () => {
  const d = await root()
  await seedSourceCanvas(d)
  const hold = await holdProject(d, 'essay')
  let rename!: ReturnType<typeof renameProject>
  let staleMigration!: ReturnType<typeof migrateSourceCardsToNotes>
  try {
    lockProbe.reset()
    rename = renameProject(d, 'essay', 'Final')
    void rename.catch(() => undefined)
    await lockProbe.waitFor((entries) => entries.some(
      (entry) => entry.kind === 'multi' && entry.dataRoot === d && entry.ids.includes('essay'),
    ))
    staleMigration = migrateSourceCardsToNotes(d)
    void staleMigration.catch(() => undefined)
    await lockProbe.waitFor((entries) => entries.some(
      (entry) => entry.kind === 'project' && entry.dataRoot === d && entry.ids[0] === 'essay',
    ))
  } finally {
    hold.release()
    await Promise.allSettled([hold.done, rename, staleMigration])
  }
  await Promise.all([hold.done, rename, staleMigration])
  await expect(fs.access(join(d, 'projects', 'essay'))).rejects.toMatchObject({ code: 'ENOENT' })
  const finalPath = canvasPathFor(d, 'final')!
  const beforeRerun = JSON.parse(await fs.readFile(finalPath, 'utf8'))
  expect(beforeRerun.document.store['shape:a'].props.kind).toBe('source')
  await migrateSourceCardsToNotes(d)
  const afterRerun = JSON.parse(await fs.readFile(finalPath, 'utf8'))
  expect(afterRerun.document.store['shape:a'].props).toMatchObject({
    kind: 'note',
    noteKind: 'quote',
  })
})

test('a completed note migration is byte-stable on rerun', async () => {
  const d = await root()
  const path = await seedSourceCanvas(d)
  await migrateSourceCardsToNotes(d)
  const once = await fs.readFile(path, 'utf8')
  const backupOnce = await fs.readFile(`${path}.bak`, 'utf8')
  await migrateSourceCardsToNotes(d)
  expect(await fs.readFile(path, 'utf8')).toBe(once)
  expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe(backupOnce)
  expect(canvasRevision(JSON.parse(once))).toBe(1)
})

test('note migration preserves epoch, sequence, and pending state while incrementing once', async () => {
  const d = await root()
  const path = await seedSourceCanvas(d)
  let current = ensureCanvasMetadata(JSON.parse(await fs.readFile(path, 'utf8'))).snapshot
  const pending: ChangeSet = {
    id: 'pending-create', author: 'claude',
    ops: [{ kind: 'create_note_card', text: 'Pending', x: 0, y: 0 }],
  }
  const added = addPendingChangeSet(current, pending, changeSetDigest(pending))
  expect(added.status).toBe('added')
  if (added.status !== 'added') return
  current = added.snapshot
  await fs.writeFile(path, JSON.stringify(current), 'utf8')
  const beforeToken = nextChangeSetToken(current)
  const beforeRevision = canvasRevision(current)

  await migrateSourceCardsToNotes(d)

  const migrated = JSON.parse(await fs.readFile(path, 'utf8'))
  expect(canvasRevision(migrated)).toBe(beforeRevision + 1)
  expect(nextChangeSetToken(migrated)).toEqual(beforeToken)
  expect(pendingChangeSetsForClient(migrated)).toEqual([{
    token: { epoch: beforeToken.epoch, sequence: 0 }, changeSet: pending,
  }])
})

test('revision-exhausted note migration persists neither record changes nor a backup', async () => {
  const d = await root()
  const path = await seedSourceCanvas(d)
  const current = ensureCanvasMetadata(JSON.parse(await fs.readFile(path, 'utf8'))).snapshot as any
  current[SERVER_CANVAS_METADATA_KEY].revision = Number.MAX_SAFE_INTEGER
  await fs.writeFile(path, JSON.stringify(current), 'utf8')
  const before = await fs.readFile(path)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

  await migrateSourceCardsToNotes(d)

  expect(logged).toHaveBeenCalled()
  expect(await fs.readFile(path)).toEqual(before)
  await expect(fs.access(`${path}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(before.toString()).document.store['shape:a'].props.kind).toBe('source')
})
