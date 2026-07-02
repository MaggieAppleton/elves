import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProject,
  listProjects,
  getProject,
  renameProject,
  isValidId,
  slugify,
  projectDir,
} from '../../server/projects'

let dirs: string[] = []
async function root() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-proj-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
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

test('rename changes name, keeps id', async () => {
  const d = await root()
  await createProject(d, 'Draft', '2026-07-02T10:00:00.000Z')
  const renamed = await renameProject(d, 'draft', 'Final Draft')
  expect(renamed).toMatchObject({ id: 'draft', name: 'Final Draft' })
  expect((await getProject(d, 'draft'))?.name).toBe('Final Draft')
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
