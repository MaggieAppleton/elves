import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EMPTY_CANVAS, readCanvas, writeCanvas, worthBackingUp } from '../../server/store'

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

test('reading a missing canvas returns a fresh empty canvas', async () => {
  const d = await tmpDir()
  expect(await readCanvas(join(d, 'canvas.json'))).toEqual(EMPTY_CANVAS)
})

test('write then read round-trips the snapshot', async () => {
  const d = await tmpDir()
  const path = join(d, 'nested', 'canvas.json')
  const snap = { document: { schema: 1, records: [] }, session: null }
  await writeCanvas(path, snap)
  expect(await readCanvas(path)).toEqual(snap)
})

test('write is atomic: no leftover temp file', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, { document: null, session: null })
  const entries = await fs.readdir(d)
  expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
})

test('concurrent writes never race on the temp file', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  const writes = Array.from({ length: 30 }, (_, i) =>
    writeCanvas(path, { document: null, session: i }),
  )
  await expect(Promise.all(writes)).resolves.toBeDefined()
  // The persisted file must be a complete, valid snapshot — never torn or empty.
  const final = await readCanvas(path)
  expect(final).toHaveProperty('document', null)
  expect(typeof (final as { session: unknown }).session).toBe('number')
  // And no temp files should be left behind, even after a stampede.
  const entries = await fs.readdir(d)
  expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
})

test('reading an empty canvas file returns a fresh empty canvas', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await fs.writeFile(path, '', 'utf8')
  expect(await readCanvas(path)).toEqual(EMPTY_CANVAS)
})

// --- Backup-on-write: the last known-good document is always recoverable -----

const DOC1 = { document: { store: { a: 1 }, schema: 1 }, session: null }
const DOC2 = { document: { store: { a: 2 }, schema: 1 }, session: null }

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

test('the very first write leaves no backup (nothing to preserve yet)', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, DOC1)
  expect(await exists(`${path}.bak`)).toBe(false)
})

test('a second write preserves the previous document as a .bak', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, DOC1)
  await writeCanvas(path, DOC2)
  expect(await readCanvas(path)).toEqual(DOC2)
  expect(await readCanvas(`${path}.bak`)).toEqual(DOC1)
})

test('a degenerate write cannot clobber a good backup with junk', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, DOC1)
  await writeCanvas(path, DOC2) // .bak = DOC1
  // A clobber (an empty store saved during a load race) lands on the main file...
  await writeCanvas(path, EMPTY_CANVAS) // .bak becomes DOC2 — still recoverable
  expect(await readCanvas(`${path}.bak`)).toEqual(DOC2)
  // ...and a SECOND degenerate write must NOT push the empty state into .bak.
  await writeCanvas(path, EMPTY_CANVAS)
  expect(await readCanvas(`${path}.bak`)).toEqual(DOC2)
})

test('worthBackingUp preserves real documents but rejects degenerate states', () => {
  expect(worthBackingUp(JSON.stringify(DOC1))).toBe(true)
  expect(worthBackingUp(JSON.stringify(EMPTY_CANVAS))).toBe(false) // {document: null}
  expect(worthBackingUp('')).toBe(false) // torn / freshly-touched file
  expect(worthBackingUp('   ')).toBe(false)
  expect(worthBackingUp('{not valid json')).toBe(false) // corrupt: don't propagate into .bak
})
