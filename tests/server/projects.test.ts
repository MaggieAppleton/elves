import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProject,
  listProjects,
  getProject,
  renameProject,
  resyncProjectIds,
  isValidId,
  slugify,
  projectDir,
} from '../../server/projects'
import { withProjectLock, withProjectNamespaceLock } from '../../server/projectLock'

const lockProbe = vi.hoisted(() => {
  type Entry = { kind: 'project' | 'multi' | 'namespace'; dataRoot: string; ids: string[] }
  const entries: Entry[] = []
  const waiters: Array<{
    predicate: (current: Entry[]) => boolean
    resolve: () => void
    reject: (error: Error) => void
    deadline: ReturnType<typeof setTimeout>
  }> = []
  return {
    entries,
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
    withProjectNamespaceLock: <T>(dataRoot: string, task: () => Promise<T>): Promise<T> => {
      const result = actual.withProjectNamespaceLock(dataRoot, task)
      lockProbe.record({ kind: 'namespace', dataRoot, ids: [] })
      return result
    },
  }
})

let dirs: string[] = []
async function root() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-proj-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  lockProbe.reset()
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('slugify makes a filesystem-safe id', () => {
  expect(slugify('Climate Essay!')).toBe('climate-essay')
  expect(slugify('  Hello   World  ')).toBe('hello-world')
  expect(slugify('   ')).toBe('project')
})

test('isValidId rejects traversal and unsafe ids', () => {
  expect(isValidId('climate-essay')).toBe(true)
  expect(isValidId('essay2')).toBe(true)
  expect(isValidId('../evil')).toBe(false)
  expect(isValidId('.hidden')).toBe(false)
  expect(isValidId('Bad Id')).toBe(false)
  expect(isValidId('')).toBe(false)
})

test('projectDir returns null for an unsafe id', async () => {
  const d = await root()
  expect(projectDir(d, '../evil')).toBeNull()
  expect(projectDir(d, 'ok-id')).toBe(join(d, 'projects', 'ok-id'))
})

test('create then list round-trips; duplicate name gets a suffix', async () => {
  const d = await root()
  const a = await createProject(d, 'Climate Essay', '2026-07-02T10:00:00.000Z')
  const b = await createProject(d, 'Climate Essay', '2026-07-02T11:00:00.000Z')
  expect(a.id).toBe('climate-essay')
  expect(b.id).toBe('climate-essay-2')
  expect(a.name).toBe('Climate Essay')
  const list = await listProjects(d)
  expect(list.map((p) => p.id)).toEqual(['climate-essay', 'climate-essay-2'])
})

test('listProjects is sorted by createdAt', async () => {
  const d = await root()
  await createProject(d, 'Second', '2026-07-02T11:00:00.000Z')
  await createProject(d, 'First', '2026-07-02T09:00:00.000Z')
  expect((await listProjects(d)).map((p) => p.name)).toEqual(['First', 'Second'])
})

test('getProject returns null for unknown id', async () => {
  const d = await root()
  expect(await getProject(d, 'nope')).toBeNull()
})

test('rename re-slugs the id and moves the folder to match the new name', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  const renamed = await renameProject(d, 'draft', 'Final Draft')
  expect(renamed).toMatchObject({ id: 'final-draft', name: 'Final Draft' })
  // Old id is gone; new id resolves and carries the content.
  expect(await getProject(d, 'draft')).toBeNull()
  expect(await getProject(d, 'final-draft')).toMatchObject({ id: 'final-draft', name: 'Final Draft' })
  expect((await listProjects(d)).map((p) => p.id)).toEqual(['final-draft'])
})

test('rename that only changes punctuation/case keeps the id (name-only write)', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  const renamed = await renameProject(d, 'draft', 'Draft!')
  expect(renamed).toMatchObject({ id: 'draft', name: 'Draft!' })
  expect((await getProject(d, 'draft'))?.name).toBe('Draft!')
})

test('rename into a slug taken by another project gets a suffix', async () => {
  const d = await root()
  await createProject(d, 'Report', '2026-07-02T10:00:00.000Z') // id: report
  await createProject(d, 'Scratch', '2026-07-02T11:00:00.000Z') // id: scratch
  const renamed = await renameProject(d, 'scratch', 'Report')
  expect(renamed).toMatchObject({ id: 'report-2', name: 'Report' })
  expect((await listProjects(d)).map((p) => p.id).sort()).toEqual(['report', 'report-2'])
})

test('rename preserves the project folder contents through the move', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  // Drop a canvas.json in the old folder, then rename and confirm it moved.
  await fs.writeFile(join(d, 'projects', 'draft', 'canvas.json'), '{"kept":true}', 'utf8')
  await renameProject(d, 'draft', 'Final')
  const moved = await fs.readFile(join(d, 'projects', 'final', 'canvas.json'), 'utf8')
  expect(JSON.parse(moved)).toEqual({ kept: true })
})

test('rename waits for an active old-project mutation and moves its result', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const mutation = withProjectLock(d, 'draft', async () => {
    await fs.writeFile(join(d, 'projects', 'draft', 'marker'), 'kept')
    entered()
    await gate
  })
  await started
  lockProbe.reset()
  const rename = renameProject(d, 'draft', 'Final')
  await lockProbe.waitFor((entries) => entries.some(
    (entry) => entry.kind === 'multi' && entry.dataRoot === d && entry.ids.includes('draft'),
  ))
  const oldDirectoryExists = await fs.access(join(d, 'projects', 'draft'))
    .then(() => true, () => false)
  release()
  await Promise.all([mutation, rename])
  expect(oldDirectoryExists).toBe(true)
  await expect(fs.readFile(join(d, 'projects', 'final', 'marker'), 'utf8')).resolves.toBe('kept')
})

test('concurrent renames allocate colliding slugs under the namespace lock', async () => {
  const d = await root()
  await createProject(d, 'Alpha', '2026-07-02T10:00:00.000Z')
  await createProject(d, 'Beta', '2026-07-02T11:00:00.000Z')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const hold = withProjectNamespaceLock(d, async () => {
    entered()
    await gate
  })
  await started
  lockProbe.reset()
  const alpha = renameProject(d, 'alpha', 'Report')
  const beta = renameProject(d, 'beta', 'Report')
  await lockProbe.waitFor((entries) => entries.filter(
    (entry) => entry.kind === 'namespace' && entry.dataRoot === d,
  ).length === 2)
  release()
  const renamed = await Promise.all([alpha, beta])
  await hold
  expect(renamed.map((project) => project.id).sort()).toEqual(['report', 'report-2'])
  expect((await listProjects(d)).map((project) => project.id).sort()).toEqual(['report', 'report-2'])
})

test('resyncProjectIds re-slugs a drifted project and is idempotent', async () => {
  const d = await root()
  // Simulate a project created under the old behaviour: folder id no longer
  // matches the display name.
  await fs.mkdir(join(d, 'projects', 'my-first-essay'), { recursive: true })
  await fs.writeFile(
    join(d, 'projects', 'my-first-essay', 'project.json'),
    JSON.stringify({ id: 'my-first-essay', name: 'Augment', createdAt: '2026-07-02T10:00:00.000Z' }),
    'utf8',
  )
  await resyncProjectIds(d)
  expect((await listProjects(d)).map((p) => p.id)).toEqual(['augment'])
  expect(await getProject(d, 'my-first-essay')).toBeNull()
  // Idempotent: a second run leaves everything alone.
  await resyncProjectIds(d)
  expect((await listProjects(d)).map((p) => p.id)).toEqual(['augment'])
})

test('resyncProjectIds disambiguates two projects that want the same slug', async () => {
  const d = await root()
  // 'keep' already owns the slug 'report'; 'old-x' (also named "Report") must
  // take report-2, and 'keep' must stay put.
  for (const [id, name, createdAt] of [
    ['report', 'Report', '2026-07-02T10:00:00.000Z'],
    ['old-x', 'Report', '2026-07-02T11:00:00.000Z'],
  ] as const) {
    await fs.mkdir(join(d, 'projects', id), { recursive: true })
    await fs.writeFile(
      join(d, 'projects', id, 'project.json'),
      JSON.stringify({ id, name, createdAt }),
      'utf8',
    )
  }
  await resyncProjectIds(d)
  expect((await listProjects(d)).map((p) => p.id).sort()).toEqual(['report', 'report-2'])
})

test('concurrent createProject calls with the same name never merge into one folder', async () => {
  const d = await root()
  const [a, b] = await Promise.all([
    createProject(d, 'Dup', '2026-07-02T10:00:00.000Z'),
    createProject(d, 'Dup', '2026-07-02T10:00:00.001Z'),
  ])
  // Two distinct ids, each with its own project.json.
  expect(a.id).not.toBe(b.id)
  expect([a.id, b.id].sort()).toEqual(['dup', 'dup-2'])
  const list = await listProjects(d)
  expect(list.map((p) => p.id).sort()).toEqual(['dup', 'dup-2'])
  const aMeta = JSON.parse(
    await fs.readFile(join(d, 'projects', a.id, 'project.json'), 'utf8'),
  )
  const bMeta = JSON.parse(
    await fs.readFile(join(d, 'projects', b.id, 'project.json'), 'utf8'),
  )
  expect(aMeta.id).toBe(a.id)
  expect(bMeta.id).toBe(b.id)
})

test('createProject claims a fresh id when the slug already exists on disk, without touching the existing folder', async () => {
  const d = await root()
  const first = await createProject(d, 'Report', '2026-07-02T10:00:00.000Z')
  expect(first.id).toBe('report')
  const second = await createProject(d, 'Report', '2026-07-02T11:00:00.000Z')
  expect(second.id).toBe('report-2')
  // The original folder/content is untouched.
  const firstMeta = JSON.parse(
    await fs.readFile(join(d, 'projects', 'report', 'project.json'), 'utf8'),
  )
  expect(firstMeta).toMatchObject({ id: 'report', createdAt: '2026-07-02T10:00:00.000Z' })
})

test('rename of an unknown project throws 404', async () => {
  const d = await root()
  await expect(renameProject(d, 'ghost', 'X')).rejects.toMatchObject({ status: 404 })
})

test('createProject rejects a blank name', async () => {
  const d = await root()
  await expect(createProject(d, '   ', 'now')).rejects.toMatchObject({ status: 400 })
})

test('listProjects on a missing root returns []', async () => {
  const d = await root()
  expect(await listProjects(d)).toEqual([])
})

test('listProjects skips a project.json missing createdAt but keeps the rest', async () => {
  const d = await root()
  await createProject(d, 'Good', '2026-07-02T10:00:00.000Z')
  await fs.mkdir(join(d, 'projects', 'bad'), { recursive: true })
  await fs.writeFile(
    join(d, 'projects', 'bad', 'project.json'),
    JSON.stringify({ id: 'bad', name: 'Bad' }),
    'utf8',
  )
  const list = await listProjects(d)
  expect(list.map((p) => p.id)).toEqual(['good'])
})

test('createProject does not reuse a malformed folder that occupies the slug', async () => {
  const d = await root()
  // A malformed project (missing name) is invisible to listProjects but its
  // folder still owns the slug 'bad' on disk, with its own canvas + assets.
  await fs.mkdir(join(d, 'projects', 'bad', 'assets'), { recursive: true })
  await fs.writeFile(
    join(d, 'projects', 'bad', 'project.json'),
    JSON.stringify({ id: 'bad', createdAt: '2026-07-02T10:00:00.000Z' }),
    'utf8',
  )
  await fs.writeFile(join(d, 'projects', 'bad', 'canvas.json'), '{"stale":true}', 'utf8')
  const created = await createProject(d, 'Bad', '2026-07-02T11:00:00.000Z')
  // The new project must take a distinct id, not reuse the occupied folder.
  expect(created.id).toBe('bad-2')
  // And it must not inherit the old folder's canvas.
  await expect(
    fs.readFile(join(d, 'projects', 'bad-2', 'canvas.json'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

test('resyncProjectIds skips a project.json missing name without throwing', async () => {
  const d = await root()
  await createProject(d, 'Good', '2026-07-02T10:00:00.000Z')
  await fs.mkdir(join(d, 'projects', 'bad'), { recursive: true })
  await fs.writeFile(
    join(d, 'projects', 'bad', 'project.json'),
    JSON.stringify({ id: 'bad', createdAt: '2026-07-02T11:00:00.000Z' }),
    'utf8',
  )
  await expect(resyncProjectIds(d)).resolves.not.toThrow()
  expect((await listProjects(d)).map((p) => p.id)).toEqual(['good'])
})
