import type { Reference, RefType, RefFetcher } from './types'

/**
 * A bare Reference with only the url known — used before/without unfurling (a
 * client fallback when the server is unreachable, or the server's own
 * minimal-reference case). Pure, so it is safe in the browser bundle.
 */
export function blankReference(
  url: string,
  now: string | null,
  refType?: RefType,
  fetchedBy: RefFetcher = 'unfurl',
): Reference {
  return {
    url,
    refType: refType ?? guessRefType(url),
    title: null,
    authors: [],
    siteName: refHost(url) || null,
    year: null,
    venue: null,
    description: null,
    faviconAssetId: null,
    thumbnailAssetId: null,
    doi: null,
    arxivId: null,
    fetchedBy,
    fetchedAt: now,
  }
}

/**
 * Pure display helpers for reference note cards. Kept out of the shape
 * component so the type-adaptive rules (what a paper vs a tweet vs a repo shows)
 * are unit-testable and shared with height measurement. Nothing here touches the
 * DOM or the network.
 */

/** Hostname without a leading www., or '' if the url is unparseable. */
export function refHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Whether url identifies a public X/Twitter status post. */
export function isXStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    const [handle, status, id] = parsed.pathname.split('/').filter(Boolean)
    return (host === 'x.com' || host === 'twitter.com') && !!handle && status === 'status' && !!id
  } catch {
    return false
  }
}

/** The author handle encoded in an X/Twitter status URL, when present. */
export function xStatusHandle(url: string): string | null {
  if (!isXStatusUrl(url)) return null
  const handle = new URL(url).pathname.split('/').filter(Boolean)[0]
  return handle ? `@${handle}` : null
}

/** "Cao", "Cao & Jiang", "Cao, Jiang & Xia", "Cao et al." (>3). */
export function authorsLabel(authors: string[]): string {
  const names = authors.filter((a) => a.trim())
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`
  return `${names[0]} et al.`
}

/**
 * Best-effort refType from a URL host alone, so a freshly pasted link renders
 * as the right *kind* of card even before richer metadata arrives. The server
 * unfurl and an agent can override this.
 */
export function guessRefType(url: string): RefType {
  const h = refHost(url).toLowerCase()
  const path = (() => { try { return new URL(url).pathname } catch { return '' } })()
  if (/(^|\.)arxiv\.org$/.test(h) || /(^|\.)doi\.org$/.test(h) || h.includes('acm.org') ||
      h.includes('semanticscholar.org') || h.includes('openreview.net') ||
      h.includes('pubmed') || h.includes('biorxiv') || h.includes('ssrn') ||
      /\.pdf$/.test(path)) return 'paper'
  if (h === 'x.com' || h === 'twitter.com' || h.endsWith('bsky.app') ||
      h.includes('mastodon') || h.includes('threads.net')) return 'social'
  if (h === 'github.com' || h === 'gitlab.com' || h.endsWith('npmjs.com') ||
      h.endsWith('pypi.org') || h.endsWith('crates.io')) return 'software'
  if (h.endsWith('wikipedia.org') || h.endsWith('wikimedia.org')) return 'wiki'
  if (h.includes('youtube.com') || h === 'youtu.be' || h.includes('vimeo.com')) return 'video'
  if (h.includes('goodreads.com') || h.includes('books.google') || h.includes('worldcat.org')) return 'book'
  return 'article'
}

/** Small-caps eyebrow label for a reference's card face. */
export function refEyebrow(ref: Reference): string {
  const site = ref.siteName || refHost(ref.url)
  switch (ref.refType) {
    case 'paper': {
      const detail = ref.venue || (ref.year ? String(ref.year) : '')
      return detail ? `Paper · ${detail}` : 'Paper'
    }
    case 'book':
      return ref.year ? `Book · ${ref.year}` : 'Book'
    case 'social':
      return ref.authors[0] || xStatusHandle(ref.url) || site || 'Post'
    case 'wiki':
      return site || 'Wikipedia'
    case 'video':
      return site || 'Video'
    case 'software':
      return site || 'Software'
    case 'article':
    case 'link':
    default:
      return site || 'Link'
  }
}

/** Secondary one-line meta (authors / year) shown under the title, or null. */
export function refMeta(ref: Reference): string | null {
  switch (ref.refType) {
    case 'paper':
    case 'article':
      return authorsLabel(ref.authors) || null
    case 'book': {
      const who = authorsLabel(ref.authors)
      return who || null
    }
    default:
      return null
  }
}

/** Two-line description shown on the face for text-forward kinds, or null. */
export function refDescription(ref: Reference): string | null {
  switch (ref.refType) {
    case 'social':
    case 'article':
    case 'software':
    case 'video':
    case 'wiki':
      return ref.description?.trim() || null
    default:
      return null
  }
}

/** Whether this reference shows a left-hand media thumbnail (cover / avatar). */
export function hasLeftMedia(ref: Reference): boolean {
  return (ref.refType === 'book' || ref.refType === 'social') && !!ref.thumbnailAssetId
}

/** The visible title, falling back to the host if there is no title yet. */
export function refTitle(ref: Reference): string {
  return ref.title?.trim() || (isXStatusUrl(ref.url) ? 'X post' : null) || refHost(ref.url) || ref.url
}
