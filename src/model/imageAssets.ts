/** Browser/server shared policy for project-local image assets. */
export const IMAGE_EXTENSIONS_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
} as const satisfies Record<string, string>

export const IMAGE_ASSET_MIME_TYPES = Object.freeze(Object.keys(IMAGE_EXTENSIONS_BY_MIME))
export const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024

export function imageExtensionForMime(mime: string): string | null {
  return mime in IMAGE_EXTENSIONS_BY_MIME
    ? IMAGE_EXTENSIONS_BY_MIME[mime as keyof typeof IMAGE_EXTENSIONS_BY_MIME]
    : null
}
