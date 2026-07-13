import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrateLegacyCanvas } from '../../server/migrate'
import { listProjects } from '../../server/projects'
import { withProjectNamespaceLock } from '../../server/projectLock'

let dirs: string[] = []
async function root() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-mig-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('migrates a legacy canvas + assets into my-first-essay', async () => {
  const d = await root()
  await fs.writeFile(
    join(d, 'canvas.json'),
    JSON.stringify({ document: { store: {} }, session: null }),
    'utf8',
  )
  await fs.mkdir(join(d, 'assets'))
  await fs.writeFile(join(d, 'assets', 'x.png'), 'bytes')

  await migrateLegacyCanvas(d, '2026-07-02T10:00:00.000Z')

  expect(await listProjects(d)).toEqual([
    { id: 'my-first-essay', name: 'My first essay', createdAt: '2026-07-02T10:00:00.000Z' },
  ])
  expect(
    await fs.readFile(join(d, 'projects', 'my-first-essay', 'assets', 'x.png'), 'utf8'),
  ).toBe('bytes')
  expect(
    await fs.readFile(join(d, 'projects', 'my-first-essay', 'canvas.json'), 'utf8'),
  ).toContain('store')
  // Moved, not copied.
  await expect(fs.stat(join(d, 'canvas.json'))).rejects.toThrow()
})

test('is idempotent when projects/ already exists', async () => {
  const d = await root()
  await fs.mkdir(join(d, 'projects'), { recursive: true })
  await fs.writeFile(join(d, 'canvas.json'), '{}', 'utf8')

  await migrateLegacyCanvas(d, 'now')

  expect(await listProjects(d)).toEqual([])
  // Legacy canvas untouched because migration short-circuited.
  await fs.stat(join(d, 'canvas.json'))
})

test('fresh install creates no projects/ dir', async () => {
  const d = await root()
  await migrateLegacyCanvas(d, 'now')
  await expect(fs.stat(join(d, 'projects'))).rejects.toThrow()
})

test('legacy migration waits for the project namespace lock', async () => {
  const d = await root()
  await fs.writeFile(join(d, 'canvas.json'), JSON.stringify({ document: { store: {} } }), 'utf8')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const hold = withProjectNamespaceLock(d, async () => {
    entered()
    await gate
  })
  await started
  let settled = false
  const migration = migrateLegacyCanvas(d, '2026-07-02T10:00:00.000Z')
    .finally(() => { settled = true })
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  const settledWhileLocked = settled
  release()
  await Promise.all([hold, migration])
  expect(settledWhileLocked).toBe(false)
  await expect(fs.readFile(
    join(d, 'projects', 'my-first-essay', 'canvas.json'),
    'utf8',
  )).resolves.toContain('document')
})
