import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EMPTY_CANVAS, readCanvas, writeCanvas } from '../../server/store'

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
