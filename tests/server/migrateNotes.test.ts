import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateSourceCardsToNotes } from '../../server/migrateNotes'
import { createProject, canvasPathFor } from '../../server/projects'
import { withProjectLock } from '../../server/projectLock'

const projectLockCalls = vi.hoisted(() => [] as Array<{ dataRoot: string; id: string }>)

vi.mock('../../server/projectLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/projectLock')>()
  return {
    ...actual,
    withProjectLock: <T>(dataRoot: string, id: string, task: () => Promise<T>): Promise<T> => {
      projectLockCalls.push({ dataRoot, id })
      return actual.withProjectLock(dataRoot, id, task)
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
  projectLockCalls.length = 0
  let settled = false
  const migration = migrateSourceCardsToNotes(d).finally(() => { settled = true })
  try {
    await vi.waitFor(() => {
      expect(projectLockCalls).toContainEqual({ dataRoot: d, id: 'essay' })
    })
    expect(settled).toBe(false)
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
})

test('a completed note migration is byte-stable on rerun', async () => {
  const d = await root()
  const path = await seedSourceCanvas(d)
  await migrateSourceCardsToNotes(d)
  const once = await fs.readFile(path, 'utf8')
  await migrateSourceCardsToNotes(d)
  expect(await fs.readFile(path, 'utf8')).toBe(once)
})
