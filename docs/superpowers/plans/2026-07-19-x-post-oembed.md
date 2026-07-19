# X Post oEmbed Implementation Plan

> **For agentic workers:** Execute this plan task-by-task inline in this session (see "Execution" note at the end — subagent-driven-development/executing-plans sub-skills are not installed in this repo). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasting an `x.com`/`twitter.com` status link renders a reference card with a real author name and tweet text, fetched from X's public oEmbed endpoint, instead of today's styled-but-empty fallback.

**Architecture:** `unfurl()` in `server/unfurl.ts` special-cases X status URLs at the top: it calls a new injected `fetchOEmbed` dep, and on success builds the `Reference` straight from the oEmbed JSON, skipping the generic HTML-fetch/parse path. On any failure (non-X URL branch not taken, oEmbed throws, or returns `null`), it falls through to the existing behavior unchanged. `server/app.ts`'s `unfurlDepsFor` implements the real `fetchOEmbed` using the same `safeFetch`/timeout/size-cap machinery already used for HTML and images.

**Tech Stack:** TypeScript, Express (server), Vitest (tests). No new dependencies.

---

### Task 1: Pure tweet-text extraction from oEmbed HTML

**Files:**
- Modify: `server/unfurl.ts`
- Test: `tests/server/unfurl.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/server/unfurl.test.ts` (near the other `describe` blocks, after the `normalizeAuthor` block):

```ts
describe('parseOEmbedTweetText', () => {
  test('strips the blockquote wrapper and decodes entities', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Shipping a new feature today &amp; feeling good about it</p>&mdash; Maggie Appleton (@Mappletons) <a href="https://twitter.com/Mappletons/status/1234567890">July 15, 2026</a></blockquote>'
    expect(parseOEmbedTweetText(html)).toBe('Shipping a new feature today & feeling good about it')
  })

  test('keeps a real link\'s visible text but drops a trailing media stub', () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">New post is up: <a href="https://t.co/xyz789">example.com/my-post</a> <a href="https://t.co/abc123">pic.twitter.com/abc123</a></p>&mdash; Jane Doe (@janedoe) <a href="https://twitter.com/janedoe/status/999">June 1, 2026</a></blockquote>'
    expect(parseOEmbedTweetText(html)).toBe('New post is up: example.com/my-post')
  })

  test('returns null when there is no <p> tag to extract', () => {
    expect(parseOEmbedTweetText('<blockquote class="twitter-tweet">no paragraph here</blockquote>')).toBeNull()
  })
})
```

Update the import at the top of `tests/server/unfurl.test.ts` to include the new function:

```ts
import {
  parseMetadata, decodeEntities, normalizeAuthor, unfurl, minimalReference, parseOEmbedTweetText,
  type UnfurlDeps,
} from '../../server/unfurl'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/unfurl.test.ts -t parseOEmbedTweetText`
Expected: FAIL — `parseOEmbedTweetText` is not exported from `server/unfurl.ts`.

- [ ] **Step 3: Implement `parseOEmbedTweetText`**

In `server/unfurl.ts`, add this function directly after `normalizeAuthor` (around line 70, before the `ParsedMeta` interface):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/unfurl.test.ts -t parseOEmbedTweetText`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/unfurl.ts tests/server/unfurl.test.ts
git commit -m "feat: parse tweet text out of an X oEmbed response"
```

---

### Task 2: Hook oEmbed into `unfurl()` with an injected dep

**Files:**
- Modify: `server/unfurl.ts`
- Test: `tests/server/unfurl.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/server/unfurl.test.ts`, inside the existing `describe('unfurl (deps injected)', ...)` block (after the `'a paper does not fetch a hero thumbnail'` test, still inside that describe so it shares the local `deps()` helper):

```ts
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
```

Update the local `deps()` factory earlier in the same `describe` block to include a default `fetchOEmbed` (it's a new required field on `UnfurlDeps`, so every existing test that builds `deps()` needs this to keep compiling):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/unfurl.test.ts -t "X status url"`
Expected: FAIL — `UnfurlDeps` has no `fetchOEmbed` property yet (TypeScript compile error via vitest/esbuild), and `unfurl()` doesn't branch on `isXStatusUrl`.

- [ ] **Step 3: Implement the branch in `unfurl()`**

In `server/unfurl.ts`, update the import at the top to include `isXStatusUrl`:

```ts
import { guessRefType, refHost, blankReference, isXStatusUrl } from '../src/model/references'
```

Add `OEmbedResult` and extend `UnfurlDeps` (replace the existing `UnfurlDeps` interface, around line 178):

```ts
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
```

Add the X branch at the very top of `unfurl()` (replace the function's opening, before the existing `let html: string`):

```ts
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
  // ...rest of the existing function body is unchanged from here
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/unfurl.test.ts`
Expected: PASS — every test in the file, including the 4 new ones and all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add server/unfurl.ts tests/server/unfurl.test.ts
git commit -m "feat: build X post references from oEmbed, with the existing fallback on failure"
```

---

### Task 3: Wire the real `fetchOEmbed` into the server route

**Files:**
- Modify: `server/app.ts`

- [ ] **Step 1: Add the byte cap constant**

In `server/app.ts`, add alongside the other `MAX_*` constants (around line 60):

```ts
const MAX_OEMBED_BYTES = 200_000
```

- [ ] **Step 2: Implement `fetchOEmbed` in `unfurlDepsFor`**

In `server/app.ts`, add a `fetchOEmbed` entry to the object returned by `unfurlDepsFor` (alongside `fetchText`, `fetchImage`, `saveImage`, `now` — insert it after `fetchImage`, around line 201):

```ts
    fetchOEmbed: async (url) => {
      try {
        return await withTimeout(
          `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`,
          'application/json',
          async (res, signal) => {
            const ct = (res.headers.get('content-type') ?? '').toLowerCase()
            if (!res.ok || !ct.includes('json')) {
              await discardBody(res)
              return null
            }
            const body = (await readBodyLimited(res, MAX_OEMBED_BYTES, signal)).toString('utf8')
            const parsed = JSON.parse(body) as Record<string, unknown>
            const authorName = typeof parsed.author_name === 'string' ? parsed.author_name : ''
            const html = typeof parsed.html === 'string' ? parsed.html : ''
            return authorName && html ? { authorName, html } : null
          },
        )
      } catch {
        return null
      }
    },
```

Note this reuses `withTimeout`, `discardBody`, `readBodyLimited`, `UNFURL_UA`, and `safeFetch` exactly as `fetchText`/`fetchImage` already do — the oEmbed endpoint URL (not the pasted status URL) is what gets fetched and SSRF-checked, and `publish.twitter.com` is a normal public host so `safeFetch`'s private-range guard passes it through unaffected.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this task has no new automated tests of its own — `fetchOEmbed`'s real network implementation is exercised manually in Task 5 — but this confirms the wiring didn't break anything).

- [ ] **Step 5: Commit**

```bash
git add server/app.ts
git commit -m "feat: implement fetchOEmbed against X's public oEmbed endpoint"
```

---

### Task 4: Update the `Reference.authors` doc-comment

**Files:**
- Modify: `src/model/types.ts:45`

- [ ] **Step 1: Update the comment**

In `src/model/types.ts`, replace the current doc-comment on `authors` (line 45):

```ts
  /** Authors (papers/books), or ["@handle"] for social, or a blog author. */
  authors: string[]
```

with:

```ts
  /**
   * Authors (papers/books), a blog author, or an X/Twitter post's author — a
   * real display name once oEmbed'd (see server/unfurl.ts), falling back to a
   * URL-derived "@handle" (see xStatusHandle) only when no author name was
   * resolved.
   */
  authors: string[]
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (comment-only change).

- [ ] **Step 3: Commit**

```bash
git add src/model/types.ts
git commit -m "docs: update Reference.authors comment for real X post authors"
```

---

### Task 5: Full verification and manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 2: Run the typechecker**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual check (requires the dev server running)**

Run: `npm run dev:all`, open the app, paste a real, currently-public X status URL (e.g. `https://x.com/<handle>/status/<id>`) onto the canvas, and confirm the resulting card shows a real author name and tweet text instead of the "X post" placeholder. Also paste a URL for a deleted/private/nonexistent status and confirm it still degrades gracefully to the existing blank 𝕏-styled card (no error surfaced, no crash).

---

## Execution

This repo does not have the `superpowers:subagent-driven-development` or `superpowers:executing-plans` sub-skills installed — execute this plan's tasks in order, inline, in the current session, committing after each task as shown above.
