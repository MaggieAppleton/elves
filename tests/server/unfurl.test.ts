import { describe, expect, test } from 'vitest'
import {
  parseMetadata, decodeEntities, normalizeAuthor, unfurl, minimalReference, parseOEmbedTweetText,
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

  test('leaves an out-of-range numeric entity literal instead of throwing', () => {
    expect(() => decodeEntities('&#1234567890;')).not.toThrow()
    expect(decodeEntities('&#1234567890;')).toBe('&#1234567890;')
  })
})

describe('normalizeAuthor', () => {
  test('flips "Last, First" and leaves plain names', () => {
    expect(normalizeAuthor('Cao, Ruanqianqian')).toBe('Ruanqianqian Cao')
    expect(normalizeAuthor('Andy Matuschak')).toBe('Andy Matuschak')
  })
})

describe('parseOEmbedTweetText', () => {
  test('strips the blockquote wrapper and decodes entities', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Shipping a new feature today &amp; feeling good about it</p>&mdash; Maggie Appleton (@Mappletons) <a href="https://twitter.com/Mappletons/status/1234567890">July 15, 2026</a></blockquote>'
    expect(parseOEmbedTweetText(html)).toBe('Shipping a new feature today & feeling good about it')
  })

  test("keeps a real link's visible text but drops a trailing media stub", () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">New post is up: <a href="https://t.co/xyz789">example.com/my-post</a> <a href="https://t.co/abc123">pic.twitter.com/abc123</a></p>&mdash; Jane Doe (@janedoe) <a href="https://twitter.com/janedoe/status/999">June 1, 2026</a></blockquote>'
    expect(parseOEmbedTweetText(html)).toBe('New post is up: example.com/my-post')
  })

  test('returns null when there is no <p> tag to extract', () => {
    expect(parseOEmbedTweetText('<blockquote class="twitter-tweet">no paragraph here</blockquote>')).toBeNull()
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

describe('parseMetadata — out-of-range numeric entity in <title>', () => {
  const BAD_ENTITY_HTML = '<html><head><title>Broken &#1234567890; Title</title></head></html>'

  test('parses metadata without throwing, leaving the bad entity literal', () => {
    expect(() => parseMetadata(BAD_ENTITY_HTML, 'https://example.com')).not.toThrow()
    const m = parseMetadata(BAD_ENTITY_HTML, 'https://example.com')
    expect(m.title).toBe('Broken &#1234567890; Title')
  })

  test('unfurl still resolves (not a 500) when the page has a bad numeric entity', async () => {
    const ref = await unfurl('https://example.com', {
      fetchText: async () => ({ html: BAD_ENTITY_HTML, finalUrl: 'https://example.com' }),
      fetchImage: async () => null,
      saveImage: async () => null,
      fetchOEmbed: async () => null,
      now: () => '2026-07-02T00:00:00.000Z',
    })
    expect(ref.title).toBe('Broken &#1234567890; Title')
  })
})

describe('unfurl (deps injected)', () => {
  function deps(over: Partial<UnfurlDeps> = {}): UnfurlDeps {
    let n = 0
    return {
      fetchText: async () => ({ html: OG_HTML, finalUrl: 'https://andymatuschak.org/posts/glimpse' }),
      fetchImage: async () => ({ bytes: Buffer.from('img'), contentType: 'image/png' }),
      saveImage: async () => `asset-${++n}`,
      fetchOEmbed: async () => null,
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

  test('X status url: builds a Reference straight from a successful oEmbed fetch', async () => {
    const ref = await unfurl('https://x.com/Mappletons/status/1234567890', deps({
      fetchOEmbed: async () => ({
        authorName: 'Maggie Appleton',
        html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Shipping a new feature today &amp; feeling good about it</p>&mdash; Maggie Appleton (@Mappletons) <a href="https://twitter.com/Mappletons/status/1234567890">July 15, 2026</a></blockquote>',
      }),
    }))
    expect(ref.refType).toBe('social')
    expect(ref.title).toBeNull()
    expect(ref.authors).toEqual(['Maggie Appleton'])
    expect(ref.description).toBe('Shipping a new feature today & feeling good about it')
    expect(ref.faviconAssetId).toBeNull()
    expect(ref.thumbnailAssetId).toBeNull()
    expect(ref.fetchedBy).toBe('unfurl')
    expect(ref.fetchedAt).toBe('2026-07-02T00:00:00.000Z')
  })

  test('X status url: falls back to a minimal reference when oEmbed returns null', async () => {
    const ref = await unfurl('https://x.com/Mappletons/status/1234567890', deps({
      fetchOEmbed: async () => null,
    }))
    expect(ref.refType).toBe('social')
    expect(ref.title).toBeNull()
    expect(ref.authors).toEqual([])
    expect(ref.description).toBeNull()
    expect(ref.fetchedBy).toBe('unfurl')
  })

  test('X status url: falls back to a minimal reference when oEmbed throws', async () => {
    const ref = await unfurl('https://x.com/Mappletons/status/1234567890', deps({
      fetchOEmbed: async () => { throw new Error('rate limited') },
    }))
    expect(ref.refType).toBe('social')
    expect(ref.authors).toEqual([])
  })

  test('non-X url never calls fetchOEmbed and uses the generic html path unchanged', async () => {
    let called = false
    const ref = await unfurl('https://andymatuschak.org/posts/glimpse', deps({
      fetchOEmbed: async () => { called = true; return null },
    }))
    expect(called).toBe(false)
    expect(ref.refType).toBe('article')
    expect(ref.title).toBe('A startling glimpse of malleable software')
  })
})

describe('minimalReference', () => {
  test('is a bare, url-only reference', () => {
    expect(minimalReference('https://x.com/a/status/1', '2026-07-02T00:00:00.000Z')).toMatchObject({
      url: 'https://x.com/a/status/1', refType: 'social', title: null, fetchedBy: 'unfurl',
    })
  })
})
