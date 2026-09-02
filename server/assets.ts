import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { imageExtensionForMime } from '../src/model/imageAssets'

export function assetsDir(canvasPath: string): string {
  return join(dirname(canvasPath), 'assets')
}

export function extForMime(mime: string): string | null {
  return imageExtensionForMime(mime)
}

export async function saveAsset(dir: string, bytes: Buffer, ext: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const assetId = `${crypto.randomUUID()}.${ext}`
  await fs.writeFile(join(dir, assetId), bytes)
  return assetId
}

export function resolveAssetPath(dir: string, assetId: string): string | null {
  if (!assetId || assetId !== basename(assetId) || assetId.startsWith('.') || assetId.includes('..')) {
    return null
  }
  return resolve(dir, assetId)
}
