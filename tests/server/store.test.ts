import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EMPTY_CANVAS,
  readCanvas,
  writeCanvas,
  worthBackingUp,
  hasDocument,
  clearCanvas,
  EmptyCanvasOverwriteError,
  ProjectGoneError,
} from '../../server/store'

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

test('a save cannot blank a canvas that holds a real document', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, DOC1)
  await writeCanvas(path, DOC2) // .bak = DOC1
  // An empty save (the EMPTY_CANVAS sentinel) over a real document is refused
  // outright — a save must never blank a canvas that holds a document.
  await expect(writeCanvas(path, EMPTY_CANVAS)).rejects.toBeInstanceOf(EmptyCanvasOverwriteError)
  // Neither the live file nor the rolling backup is touched by the refused write.
  expect(await readCanvas(path)).toEqual(DOC2)
  expect(await readCanvas(`${path}.bak`)).toEqual(DOC1)
})

test('an empty save is allowed when the canvas is empty or missing', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  // Missing file: nothing to lose, so an empty write is fine (a fresh project).
  await expect(writeCanvas(path, EMPTY_CANVAS)).resolves.toBeUndefined()
  expect(await readCanvas(path)).toEqual(EMPTY_CANVAS)
  // Already-empty file: still allowed (the guard only protects real documents).
  await expect(writeCanvas(path, { document: null, session: 1 })).resolves.toBeUndefined()
  expect((await readCanvas(path) as { session: unknown }).session).toBe(1)
})

test('hasDocument distinguishes real documents from the empty sentinel', () => {
  expect(hasDocument(DOC1)).toBe(true)
  expect(hasDocument(EMPTY_CANVAS)).toBe(false)
  expect(hasDocument({ document: null, session: null })).toBe(false)
  expect(hasDocument(null)).toBe(false)
  expect(hasDocument(undefined)).toBe(false)
})

// --- clearCanvas: the explicit, intentional clear (distinct from a save) ------

test('clearCanvas backs up the document, then removes the file', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await writeCanvas(path, DOC1)
  await clearCanvas(path)
  // File gone → reads back as the empty sentinel; the cleared document survives in .bak.
  expect(await exists(path)).toBe(false)
  expect(await readCanvas(path)).toEqual(EMPTY_CANVAS)
  expect(await readCanvas(`${path}.bak`)).toEqual(DOC1)
})

test('clearCanvas on a missing canvas is a no-op', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await expect(clearCanvas(path)).resolves.toBeUndefined()
  expect(await exists(path)).toBe(false)
})

// --- stillValid guard (#36): a write must never resurrect a directory whose
// guard says it's gone ---------------------------------------------------

test('writeCanvas without a guard behaves exactly as before (creates dirs as needed)', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await expect(writeCanvas(path, DOC1)).resolves.toBeUndefined()
})

test('a failing stillValid guard refuses the write and does not recreate the directory', async () => {
  const d = await tmpDir()
  const dir = join(d, 'project')
  const path = join(dir, 'canvas.json')
  // Nothing exists yet at `dir` — simulating a directory removed/renamed away
  // between the caller resolving `path` and this write running.
  await expect(writeCanvas(path, DOC1, async () => false)).rejects.toBeInstanceOf(ProjectGoneError)
  // The guard's refusal must win before any directory creation: `dir` itself
  // must not have been (re)created by the write.
  expect(await exists(dir)).toBe(false)
})

test('a passing stillValid guard lets the write through as usual', async () => {
  const d = await tmpDir()
  const path = join(d, 'canvas.json')
  await expect(writeCanvas(path, DOC1, async () => true)).resolves.toBeUndefined()
  expect(await readCanvas(path)).toEqual(DOC1)
})

test('worthBackingUp preserves real documents but rejects degenerate states', () => {
  expect(worthBackingUp(JSON.stringify(DOC1))).toBe(true)
  expect(worthBackingUp(JSON.stringify(EMPTY_CANVAS))).toBe(false) // {document: null}
  expect(worthBackingUp('')).toBe(false) // torn / freshly-touched file
  expect(worthBackingUp('   ')).toBe(false)
  expect(worthBackingUp('{not valid json')).toBe(false) // corrupt: don't propagate into .bak
})
