import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findSyncConflicts, warnOnSyncConflicts } from '../../server/conflicts'

let dirs: string[] = []
async function tmpDir() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('no projects dir yet returns no conflicts', async () => {
  const d = await tmpDir()
  expect(await findSyncConflicts(d)).toEqual([])
})

test('a clean projects tree returns no conflicts', async () => {
  const d = await tmpDir()
  await fs.mkdir(join(d, 'projects', 'p1', 'assets'), { recursive: true })
  await fs.writeFile(join(d, 'projects', 'p1', 'canvas.json'), '{}')
  await fs.writeFile(join(d, 'projects', 'p1', 'assets', 'a.png'), 'x')
  expect(await findSyncConflicts(d)).toEqual([])
})

test('finds sync-conflict files anywhere under projects, sorted', async () => {
  const d = await tmpDir()
  const p1 = join(d, 'projects', 'p1')
  const assets = join(p1, 'assets')
  await fs.mkdir(assets, { recursive: true })
  const conflictCanvas = join(p1, 'canvas.sync-conflict-20260706-120000-ABCDEF.json')
  const conflictAsset = join(assets, 'a.sync-conflict-20260706-120100-ABCDEF.png')
  await fs.writeFile(join(p1, 'canvas.json'), '{}')
  await fs.writeFile(conflictCanvas, '{}')
  await fs.writeFile(conflictAsset, 'x')
  expect(await findSyncConflicts(d)).toEqual([conflictAsset, conflictCanvas].sort())
})

test('warnOnSyncConflicts logs one summary + one line per conflict, and is silent when clean', async () => {
  const d = await tmpDir()
  const p1 = join(d, 'projects', 'p1')
  await fs.mkdir(p1, { recursive: true })
  await fs.writeFile(join(p1, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'), '{}')

  const lines: string[] = []
  await warnOnSyncConflicts(d, (m) => lines.push(m))
  expect(lines.length).toBe(2) // summary + one path
  expect(lines[0]).toMatch(/conflict/i)
  expect(lines[1]).toContain('canvas.sync-conflict-')

  const clean = await tmpDir()
  const cleanLines: string[] = []
  await warnOnSyncConflicts(clean, (m) => cleanLines.push(m))
  expect(cleanLines).toEqual([])
})
