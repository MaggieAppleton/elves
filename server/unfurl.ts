import type { Reference, RefType } from '../src/model/types'
import { guessRefType, refHost, blankReference, isXStatusUrl } from '../src/model/references'

/**
 * Turn a URL into a structured Reference by fetching the page and parsing its
 * OpenGraph / Twitter-card / Google-Scholar (`citation_*`) / `<title>` metadata.
 *
 * The parsing is pure and dependency-free (regex over the tags) so it can be
 * unit-tested against HTML fixtures. All I/O — fetching the page, downloading
 * the favicon and hero image, writing them to the project's assets — is injected
 * via UnfurlDeps, so the network stays out of the tests and the route wires the
 * real implementations.
 */

// --- Pure parsing --------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? ENTITIES[code] ?? whole
  })
}

/** Parse the attributes of a single `<meta …>` / `<link …>` tag. */
function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

function resolveUrl(base: string, maybeRelative: string): string | null {
  if (!maybeRelative) return null
  try {
    return new URL(maybeRelative, base).toString()
  } catch {
    return null
  }
}

/** A four-digit year (1900–2099) found anywhere in a string, or null. */
function parseYear(s: string | undefined): number | null {
  if (!s) return null
  const m = s.match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : null
}

/** Normalise "Last, First" → "First Last"; leave "First Last" untouched. */
export function normalizeAuthor(raw: string): string {
  const a = raw.trim().replace(/\s+/g, ' ')
  const comma = a.indexOf(',')
  if (comma > 0 && a.indexOf(',', comma + 1) === -1) {
    const last = a.slice(0, comma).trim()
    const first = a.slice(comma + 1).trim()
    if (last && first) return `${first} ${last}`
  }
  return a
}

/**
 * Extract and clean the tweet body from an X oEmbed response's `html` field
 * — a `<blockquote>` whose first `<p>` holds the tweet text. Strips inner
 * tags (keeping a linked url's visible text), decodes entities, and trims a
 * trailing `pic.twitter.com/...` media stub since it's a dead link once
 * rendered as plain text.
 */
export function parseOEmbedTweetText(html: string): string | null {
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  if (!p) return null
  const withoutTags = p[1].replace(/<[^>]+>/g, '')
  const decoded = decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
  const withoutMediaStub = decoded.replace(/\s*pic\.twitter\.com\/\S+$/i, '').trim()
  return withoutMediaStub || null
}

export interface ParsedMeta {
  refType: RefType
  title: string | null
  siteName: string | null
  description: string | null
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  arxivId: string | null
  imageUrl: string | null
  faviconUrl: string | null
}

export function parseMetadata(html: string, url: string): ParsedMeta {
  const single: Record<string, string> = {} // first value wins for og:/twitter:/name
  const citationAuthors: string[] = []
  const genericAuthors: string[] = []

  for (const raw of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = tagAttrs(raw)
    const key = (a.property || a.name || a.itemprop || '').toLowerCase()
    const content = a.content
    if (!key || content == null || content === '') continue
    if (key === 'citation_author' || key === 'citation_authors') citationAuthors.push(content)
    else if (key === 'author' || key === 'article:author' || key === 'dc.creator') genericAuthors.push(content)
    else if (!(key in single)) single[key] = content
  }

  // Title / description / site fall back through the common tag families.
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title =
    single['og:title'] || single['twitter:title'] || single['citation_title'] ||
    (titleTag ? decodeEntities(titleTag[1]).trim() : '') || null
  const description =
    single['og:description'] || single['twitter:description'] || single['description'] || null
  const siteName = single['og:site_name'] || refHost(url) || null

  // Favicon: prefer a declared <link rel="icon">, else the conventional path.
  let faviconUrl: string | null = null
  let iconRank = -1
  for (const raw of html.match(/<link\b[^>]*>/gi) ?? []) {
    const a = tagAttrs(raw)
    const rel = (a.rel || '').toLowerCase()
    if (!a.href || !/\b(icon|shortcut icon|apple-touch-icon)\b/.test(rel)) continue
    // Prefer apple-touch-icon (bigger) > icon > shortcut icon.
    const rank = rel.includes('apple-touch') ? 2 : rel.includes('shortcut') ? 0 : 1
    if (rank > iconRank) { iconRank = rank; faviconUrl = resolveUrl(url, a.href) }
  }
  if (!faviconUrl) faviconUrl = resolveUrl(url, '/favicon.ico')

  const authors = (citationAuthors.length ? citationAuthors : genericAuthors)
    .map(normalizeAuthor)
    .filter(Boolean)

  const year =
    parseYear(single['citation_publication_date']) ??
    parseYear(single['citation_date']) ??
    parseYear(single['article:published_time']) ??
    parseYear(single['citation_year'])
  const venue =
    single['citation_journal_title'] || single['citation_conference_title'] ||
    single['citation_inbook_title'] || single['citation_technical_report_institution'] || null

  let doi = single['citation_doi'] || null
  if (!doi) {
    const m = url.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/)
    if (m && /doi\.org/.test(url)) doi = m[0]
  }
  let arxivId = single['citation_arxiv_id'] || null
  if (!arxivId) {
    const m = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)
    if (m) arxivId = m[1]
  }

  // refType: start from the URL, upgrade to paper on citation metadata, and let
  // og:type name a video / book / article when it's more specific.
  let refType: RefType = guessRefType(url)
  const ogType = (single['og:type'] || '').toLowerCase()
  if (single['citation_title'] || citationAuthors.length || arxivId || doi) refType = 'paper'
  else if (ogType.startsWith('video')) refType = 'video'
  else if (ogType.includes('book') || ogType.includes('profile.book')) refType = 'book'
  else if (ogType === 'article' && refType === 'link') refType = 'article'

  return {
    refType,
    title,
    siteName,
    description,
    authors,
    year,
    venue,
    doi,
    arxivId,
    imageUrl: resolveUrl(url, single['og:image'] || single['twitter:image'] || single['og:image:url'] || ''),
    faviconUrl,
  }
}

// --- Network-backed unfurl (deps injected) -------------------------------

export interface FetchedImage {
  bytes: Buffer
  contentType: string
}

export interface OEmbedResult {
  authorName: string
  html: string
}

export interface UnfurlDeps {
  fetchText: (url: string) => Promise<{ html: string; finalUrl: string }>
  fetchImage: (url: string) => Promise<FetchedImage | null>
  saveImage: (img: FetchedImage) => Promise<string | null>
  fetchOEmbed: (url: string) => Promise<OEmbedResult | null>
  now: () => string
}

/** A bare Reference for when a page can't be fetched or parsed. */
export function minimalReference(url: string, now: string, refType?: RefType): Reference {
  return blankReference(url, now, refType)
}

export async function unfurl(url: string, deps: UnfurlDeps): Promise<Reference> {
  if (isXStatusUrl(url)) {
    try {
      const oembed = await deps.fetchOEmbed(url)
      if (oembed) {
        return {
          url,
          refType: 'social',
          title: null,
          authors: oembed.authorName ? [oembed.authorName] : [],
          siteName: refHost(url) || null,
          year: null,
          venue: null,
          description: parseOEmbedTweetText(oembed.html),
          faviconAssetId: null,
          thumbnailAssetId: null,
          doi: null,
          arxivId: null,
          fetchedBy: 'unfurl',
          fetchedAt: deps.now(),
        }
      }
    } catch {
      // fall through to the minimal reference below
    }
    return minimalReference(url, deps.now())
  }

  let html: string
  let finalUrl = url
  try {
    const r = await deps.fetchText(url)
    html = r.html
    finalUrl = r.finalUrl || url
  } catch {
    return minimalReference(url, deps.now())
  }

  let meta: ParsedMeta
  try {
    meta = parseMetadata(html, finalUrl)
  } catch {
    return minimalReference(url, deps.now())
  }

  const saveFrom = async (imgUrl: string | null): Promise<string | null> => {
    if (!imgUrl) return null
    try {
      const img = await deps.fetchImage(imgUrl)
      return img ? await deps.saveImage(img) : null
    } catch {
      return null
    }
  }
  const faviconAssetId = await saveFrom(meta.faviconUrl)
  // A hero thumbnail only helps the type-adaptive faces that show one.
  const wantsThumb = meta.refType === 'article' || meta.refType === 'video' ||
    meta.refType === 'social' || meta.refType === 'book'
  const thumbnailAssetId = wantsThumb ? await saveFrom(meta.imageUrl) : null

  return {
    url,
    refType: meta.refType,
    title: meta.title,
    authors: meta.authors,
    siteName: meta.siteName,
    year: meta.year,
    venue: meta.venue,
    description: meta.description,
    faviconAssetId,
    thumbnailAssetId,
    doi: meta.doi,
    arxivId: meta.arxivId,
    fetchedBy: 'unfurl',
    fetchedAt: deps.now(),
  }
}
