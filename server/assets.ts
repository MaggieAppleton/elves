import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
}

export function assetsDir(canvasPath: string): string {
  return join(dirname(canvasPath), 'assets')
}

export function extForMime(mime: string): string | null {
  return EXT_BY_MIME[mime] ?? null
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
