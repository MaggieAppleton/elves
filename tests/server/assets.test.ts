import { afterEach, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assetsDir, extForMime, saveAsset, resolveAssetPath } from '../../server/assets'

let dirs: string[] = []
async function tmp() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-assets-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('assetsDir is the assets sibling of the canvas file', () => {
  expect(assetsDir('/x/y/data/canvas.json')).toBe(join('/x/y/data', 'assets'))
})

test('extForMime maps image mimes and rejects others', () => {
  expect(extForMime('image/png')).toBe('png')
  expect(extForMime('image/jpeg')).toBe('jpg')
  expect(extForMime('text/plain')).toBeNull()
})

test('saveAsset writes <uuid>.<ext> and returns the id', async () => {
  const d = await tmp()
  const id = await saveAsset(d, Buffer.from([1, 2, 3]), 'png')
  expect(id).toMatch(/^[0-9a-f-]+\.png$/)
  expect(await fs.readFile(join(d, id))).toEqual(Buffer.from([1, 2, 3]))
})

test('resolveAssetPath rejects path traversal and accepts a bare filename', () => {
  const d = '/assets'
  expect(resolveAssetPath(d, 'a/b.png')).toBeNull()
  expect(resolveAssetPath(d, '../secret')).toBeNull()
  expect(resolveAssetPath(d, '.hidden')).toBeNull()
  expect(resolveAssetPath(d, 'abc.png')).toBe(join('/assets', 'abc.png'))
})
