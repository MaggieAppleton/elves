# X Post oEmbed Design

## Goal

Pasting an `x.com`/`twitter.com` status link should render a reference card with the real author name and tweet text, not just the styled-but-empty fallback shipped in PR #142 — using X's public, unauthenticated oEmbed endpoint (no API key, no headless browser).

## Design

**Hook point.** `unfurl()` in `server/unfurl.ts` checks `isXStatusUrl(url)` first. If true, it tries the new `deps.fetchOEmbed(url)` dep; on success it builds the `Reference` directly from that response and returns early, skipping the generic HTML fetch/parse path entirely. If `isXStatusUrl(url)` is false, or `fetchOEmbed` throws/returns `null`, control falls through to today's existing generic-unfurl path unchanged (which, for a non-oEmbed'd X URL, still ends in the current blank/styled fallback via `minimalReference`).

**Fetching.** `unfurlDepsFor` in `server/app.ts` implements `fetchOEmbed` as a `safeFetch` call to `https://publish.twitter.com/oembed?url=<encoded-status-url>&omit_script=true`, reusing the existing `UNFURL_UA` header and timeout/size-cap machinery (`withTimeout`, `FETCH_TIMEOUT_MS`). Non-200 responses, timeouts, and JSON-parse failures all resolve to `null` — no throwing across the dep boundary. Response shape consumed: `{ author_name: string, html: string }`.

**Parsing.** A new pure function in `server/unfurl.ts`, `parseOEmbedTweetText(html: string): string | null`, extracts the tweet body from the oEmbed response's `html` field (a `<blockquote>` whose first `<p>` holds the tweet text): pull the `<p>...</p>` inner content, strip remaining tags, decode entities via the existing `decodeEntities` helper, trim a trailing `pic.twitter.com/...` media-stub link (it's a dead reference with no real content once rendered as plain text). `author_name` is used directly from the JSON, no HTML parsing needed for it.

**Mapping into `Reference`.** No schema changes. For a successful oEmbed fetch:
- `refType: 'social'`
- `title: null` — `refTitle()`'s existing fallback already renders "X post" when `title` is null for an X status URL, so no title-specific handling is needed
- `authors: [author_name]` — a real display name now, where previously `authors` was always `[]` for this path and the card's eyebrow fell back to a URL-derived `@handle` via `xStatusHandle`. Update the doc-comment on `Reference.authors` (`src/model/types.ts`) to reflect that social authors are a display name when unfurled, with the `@handle` fallback only used when no author name is available.
- `description`: the parsed tweet text (renders through the existing `refDescription` social case)
- `year`, `venue`, `doi`, `arxivId`, `faviconAssetId`, `thumbnailAssetId`: all `null` — no image fetch is attempted for oEmbed'd posts, keeping this change scoped to text content only
- `fetchedBy: 'unfurl'`, `fetchedAt: deps.now()`

**Failure path.** Any oEmbed failure (deleted/private tweet, endpoint rate-limit, network error, malformed JSON) is caught inside `unfurl()` and falls through to the existing `minimalReference(url, deps.now())` call — the same blank, 𝕏-styled card the app already renders today. No new UI state, no visible error surfaced to the user.

## Verification

- Unit-test `parseOEmbedTweetText` directly against realistic oEmbed `html` fixtures: plain text, text with an embedded link, text with a trailing `pic.twitter.com` media stub, and entity-encoded text (`&amp;`, `&mdash;`, etc).
- Extend `tests/server/unfurl.test.ts` with a fake `fetchOEmbed` dep:
  - success case — assert the returned `Reference` has `refType: 'social'`, `authors[0]` equal to the fixture's `author_name`, and `description` equal to the cleaned tweet text.
  - failure case (`fetchOEmbed` returns `null`) — assert the result matches today's fallback behavior (equivalent to `minimalReference`/`blankReference` for an X status URL).
  - non-X URL — assert `fetchOEmbed` is never called and the generic HTML path runs exactly as before (no regression to existing tests).
- Manual check: paste a real, currently-public X status URL onto the canvas locally and confirm the card shows a real author name and tweet text instead of the "X post" placeholder.
