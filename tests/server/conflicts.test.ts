import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findAheadConflict, findSyncConflicts, warnOnSyncConflicts } from '../../server/conflicts'
import { createProject, canvasPathFor } from '../../server/projects'

function canvasWithMetadata(revision: number, epoch: string) {
  return JSON.stringify({
    document: { store: {} },
    session: null,
    __elves: {
      revision, epoch, nextSequence: 0,
      recentDigests: [], pendingChangeSets: [], legacyReceipts: [],
    },
  })
}

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

test('findAheadConflict returns null when there are no conflict siblings', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  await fs.writeFile(canvasPath, canvasWithMetadata(5, 'epoch-a'))
  expect(await findAheadConflict(canvasPath)).toBeNull()
})

test('findAheadConflict returns null when every sibling is behind or equal', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  await fs.writeFile(canvasPath, canvasWithMetadata(10, 'epoch-a'))
  await fs.writeFile(
    join(d, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'),
    canvasWithMetadata(9, 'epoch-a'),
  )
  await fs.writeFile(
    join(d, 'canvas.sync-conflict-20260706-120100-ABCDEF.json'),
    canvasWithMetadata(10, 'epoch-a'),
  )
  expect(await findAheadConflict(canvasPath)).toBeNull()
})

test('findAheadConflict ignores a higher-revision sibling from a DIFFERENT epoch', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  await fs.writeFile(canvasPath, canvasWithMetadata(5, 'epoch-a'))
  await fs.writeFile(
    join(d, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'),
    canvasWithMetadata(999, 'epoch-b'),
  )
  expect(await findAheadConflict(canvasPath)).toBeNull()
})

test('findAheadConflict finds the highest same-epoch sibling ahead of the live revision', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  await fs.writeFile(canvasPath, canvasWithMetadata(193, 'epoch-a'))
  const midPath = join(d, 'canvas.sync-conflict-20260719-142702-Y7662P2.json')
  const bestPath = join(d, 'canvas.sync-conflict-20260719-143455-Y7662P2.json')
  await fs.writeFile(midPath, canvasWithMetadata(208, 'epoch-a'))
  await fs.writeFile(bestPath, canvasWithMetadata(229, 'epoch-a'))
  // An unrelated, older-epoch conflict file must not interfere.
  await fs.writeFile(
    join(d, 'canvas.sync-conflict-20260715-064600-MJ2JNTM.json'),
    canvasWithMetadata(13, 'epoch-old'),
  )
  expect(await findAheadConflict(canvasPath)).toEqual({ path: bestPath, revision: 229 })
})

test('findAheadConflict skips a corrupt sibling instead of throwing', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  await fs.writeFile(canvasPath, canvasWithMetadata(5, 'epoch-a'))
  await fs.writeFile(join(d, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'), 'not json{{{')
  await expect(findAheadConflict(canvasPath)).resolves.toBeNull()
})

test('findAheadConflict never writes to disk', async () => {
  const d = await tmpDir()
  const canvasPath = join(d, 'canvas.json')
  const before = canvasWithMetadata(5, 'epoch-a')
  await fs.writeFile(canvasPath, before)
  await fs.writeFile(
    join(d, 'canvas.sync-conflict-20260706-120000-ABCDEF.json'),
    canvasWithMetadata(50, 'epoch-a'),
  )
  await findAheadConflict(canvasPath)
  expect(await fs.readFile(canvasPath, 'utf8')).toBe(before)
})

test('warnOnSyncConflicts logs a loud possible-data-loss line only when a sibling is truly ahead', async () => {
  const d = await tmpDir()
  await createProject(d, 'Essay', '2026-07-19T00:00:00.000Z')
  const canvasPath = canvasPathFor(d, 'essay')!
  await fs.writeFile(canvasPath, canvasWithMetadata(193, 'epoch-a'))
  await fs.writeFile(
    join(d, 'projects', 'essay', 'canvas.sync-conflict-20260719-143455-Y7662P2.json'),
    canvasWithMetadata(229, 'epoch-a'),
  )

  const lines: string[] = []
  await warnOnSyncConflicts(d, (m) => lines.push(m))
  expect(lines.some((l) => /POSSIBLE DATA LOSS/.test(l))).toBe(true)
  expect(lines.some((l) => l.includes('revision 229'))).toBe(true)

  // A conflict that's merely older is not a loss — no loud line for it.
  const clean = await tmpDir()
  await createProject(clean, 'Essay', '2026-07-19T00:00:00.000Z')
  const cleanCanvasPath = canvasPathFor(clean, 'essay')!
  await fs.writeFile(cleanCanvasPath, canvasWithMetadata(10, 'epoch-a'))
  await fs.writeFile(
    join(clean, 'projects', 'essay', 'canvas.sync-conflict-20260706-120000-ABCDEF.json'),
    canvasWithMetadata(3, 'epoch-a'),
  )
  const cleanLines: string[] = []
  await warnOnSyncConflicts(clean, (m) => cleanLines.push(m))
  expect(cleanLines.some((l) => /POSSIBLE DATA LOSS/.test(l))).toBe(false)
})
