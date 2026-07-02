import { describe, expect, test } from 'vitest'
import {
  parseMetadata, decodeEntities, normalizeAuthor, unfurl, minimalReference,
  type UnfurlDeps,
} from '../../server/unfurl'

const OG_HTML = `<!doctype html><html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="A startling glimpse of malleable software">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Andy Matuschak">
  <meta name="description" content="LLM-generated Obsidian plugins &amp; more">
  <meta property="og:image" content="/images/hero.png">
  <link rel="icon" href="/favicon.ico">
  <meta name="author" content="Andy Matuschak">
</head><body></body></html>`

const PAPER_HTML = `<html><head>
  <meta name="citation_title" content="Task-Driven Data Models for Malleable Software">
  <meta name="citation_author" content="Cao, Ruanqianqian">
  <meta name="citation_author" content="Jiang, Yuan">
  <meta name="citation_author" content="Xia, Haijun">
  <meta name="citation_publication_date" content="2025/04/26">
  <meta name="citation_journal_title" content="CHI 2025">
  <meta name="citation_doi" content="10.1145/1234.5678">
  <meta property="og:image" content="https://arxiv.org/thumb.png">
</head></html>`

describe('decodeEntities', () => {
  test('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b')
    expect(decodeEntities('it&#39;s')).toBe("it's")
    expect(decodeEntities('x&#x27;y')).toBe("x'y")
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>')
  })
})

describe('normalizeAuthor', () => {
  test('flips "Last, First" and leaves plain names', () => {
    expect(normalizeAuthor('Cao, Ruanqianqian')).toBe('Ruanqianqian Cao')
    expect(normalizeAuthor('Andy Matuschak')).toBe('Andy Matuschak')
  })
})

describe('parseMetadata — OpenGraph article', () => {
  const m = parseMetadata(OG_HTML, 'https://andymatuschak.org/posts/glimpse')
  test('reads title/site/description and resolves relative urls', () => {
    expect(m.refType).toBe('article')
    expect(m.title).toBe('A startling glimpse of malleable software')
    expect(m.siteName).toBe('Andy Matuschak')
    expect(m.description).toBe('LLM-generated Obsidian plugins & more')
    expect(m.imageUrl).toBe('https://andymatuschak.org/images/hero.png')
    expect(m.faviconUrl).toBe('https://andymatuschak.org/favicon.ico')
    expect(m.authors).toEqual(['Andy Matuschak'])
  })
})

describe('parseMetadata — academic paper (citation_* tags)', () => {
  const m = parseMetadata(PAPER_HTML, 'https://arxiv.org/abs/2501.01234')
  test('extracts authors, year, venue, doi, arxivId and forces refType paper', () => {
    expect(m.refType).toBe('paper')
    expect(m.title).toBe('Task-Driven Data Models for Malleable Software')
    expect(m.authors).toEqual(['Ruanqianqian Cao', 'Yuan Jiang', 'Haijun Xia'])
    expect(m.year).toBe(2025)
    expect(m.venue).toBe('CHI 2025')
    expect(m.doi).toBe('10.1145/1234.5678')
    expect(m.arxivId).toBe('2501.01234')
  })
})

describe('parseMetadata — title fallback', () => {
  test('uses <title> when no og/citation title exists', () => {
    const m = parseMetadata('<html><head><title>Just A Title</title></head></html>', 'https://example.com')
    expect(m.title).toBe('Just A Title')
    expect(m.siteName).toBe('example.com')
  })
})

describe('unfurl (deps injected)', () => {
  function deps(over: Partial<UnfurlDeps> = {}): UnfurlDeps {
    let n = 0
    return {
      fetchText: async () => ({ html: OG_HTML, finalUrl: 'https://andymatuschak.org/posts/glimpse' }),
      fetchImage: async () => ({ bytes: Buffer.from('img'), contentType: 'image/png' }),
      saveImage: async () => `asset-${++n}`,
      now: () => '2026-07-02T00:00:00.000Z',
      ...over,
    }
  }

  test('caches favicon + hero as assets and stamps provenance', async () => {
    const ref = await unfurl('https://andymatuschak.org/posts/glimpse', deps())
    expect(ref.refType).toBe('article')
    expect(ref.title).toBe('A startling glimpse of malleable software')
    expect(ref.faviconAssetId).toBe('asset-1')  // favicon saved first
    expect(ref.thumbnailAssetId).toBe('asset-2') // then the article hero
    expect(ref.fetchedBy).toBe('unfurl')
    expect(ref.fetchedAt).toBe('2026-07-02T00:00:00.000Z')
  })

  test('degrades to a minimal reference when the page cannot be fetched', async () => {
    const ref = await unfurl('https://arxiv.org/abs/2501.01234', deps({
      fetchText: async () => { throw new Error('offline') },
    }))
    expect(ref.title).toBeNull()
    expect(ref.refType).toBe('paper') // still guessed from the url
    expect(ref.faviconAssetId).toBeNull()
    expect(ref.fetchedBy).toBe('unfurl')
  })

  test('a paper does not fetch a hero thumbnail', async () => {
    const ref = await unfurl('https://arxiv.org/abs/2501.01234', deps({
      fetchText: async () => ({ html: PAPER_HTML, finalUrl: 'https://arxiv.org/abs/2501.01234' }),
    }))
    expect(ref.thumbnailAssetId).toBeNull() // wantsThumb is false for papers
    expect(ref.faviconAssetId).toBe('asset-1')
  })
})

describe('minimalReference', () => {
  test('is a bare, url-only reference', () => {
    expect(minimalReference('https://x.com/a/status/1', '2026-07-02T00:00:00.000Z')).toMatchObject({
      url: 'https://x.com/a/status/1', refType: 'social', title: null, fetchedBy: 'unfurl',
    })
  })
})
