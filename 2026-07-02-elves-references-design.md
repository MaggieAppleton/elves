# Elves — External references (design)

*2026-07-02. Follows the Phase 1–4 work in `2026-07-01-elves-*`. Status: design approved, building.*

## The problem

Elves essays lean heavily on external sources — academic papers, software
projects, blog posts, books, tweets/Bluesky posts, Wikipedia, archive links.
Today every one of these lands on the canvas as a flat `source` / `text` card
with the same muted **Note** badge. In the "Augment Essay" project a whole
cluster of cards are references living as plain transcribed text:

- *"Brad Cox proposed 'Software ICs' in 1986…"* (a book)
- *"The CHI generative/malleable-UI papers: Cao, Jiang & Xia 2025 … Min, Jiang, Huang & Xia…"* (papers)
- *"Andy Matuschak: 'A startling glimpse of malleable software…'"* (blog posts)
- Home Assistant, FullCalendar, tldraw, Obsidian, CodeMirror, D3 (software)
- `memetic.software`, Webstrates, Philip Tchernavskij, Mark Burgess (sites/people)

None is clickable, none carries a title/author/year, none shows a favicon or
thumbnail, and Claude has no way to turn a plain-text mention into a real,
linked, metadata-bearing reference. There is even a `§ "References to chase"`
section — the canvas knows these are special; the software doesn't model them.

## The principle that makes this safe

A reference is **reference material** → it is a **`source` card**, never prose.
Every new thing Claude does here (create a reference, fetch its metadata,
research a topic) is the same *category* of action as `create_source_card` and
image transcription: authoring source material, not prose. **The "never writes
prose" boundary is untouched.** A reference card's own `text` field stays the
user's *annotation* (their words about the source); the bibliographic facts live
in a separate `reference` object that Claude/the app may write. Facts vs. voice
stay cleanly separated.

## 1. Data model

A reference is a **third shape of source card** — a new `sourceKind`, not a new
top-level `kind`. `kind` stays `source`; `origin` stays orthogonal provenance.
This reuses all merge/move/comment/undo machinery and the boundary checks for
free (the code already branches on `sourceKind` for images).

```ts
export type SourceKind = 'text' | 'image' | 'reference'   // + reference

export type RefType =
  | 'paper' | 'article' | 'book' | 'software'
  | 'social' | 'video' | 'wiki' | 'link'   // link = fallback

export interface Reference {
  url: string
  refType: RefType
  title: string | null
  authors: string[]          // ["Cao","Jiang","Xia"] | ["@tchernavskij"]
  siteName: string | null    // "arxiv.org", "andymatuschak.org"
  year: number | null
  venue: string | null       // "CHI 2025", journal, publisher
  description: string | null // OG description / abstract / post text
  faviconAssetId: string | null    // cached locally (reuse assets pipeline)
  thumbnailAssetId: string | null  // OG image / cover / avatar (local)
  doi: string | null
  arxivId: string | null
  fetchedBy: 'unfurl' | 'claude' | 'user' | null  // conflict precedence
  fetchedAt: string | null
}
```

`CardProps` gains `reference: Reference | null` (set only when
`sourceKind === 'reference'`). Added via an `AddReference` shape migration
(`up: reference = null`) exactly like the existing `AddComments` / `AddAssetId`
migrations — additive and backward-safe. Favicons/thumbnails are stored as
**local asset files** through the existing assets pipeline, so a project stays a
portable, offline folder; `canvas.json` keeps only asset ids.

## 2. Rendering — type-adaptive card

A new branch in `CardShapeUtil` for `sourceKind === 'reference'` renders a
`ReferenceCard` that switches on `refType`:

| refType | face |
| --- | --- |
| paper | eyebrow `PAPER · {venue} {year}`, title, `Cao, Jiang & Xia`, footer `↗ doi/site` |
| article | favicon + siteName eyebrow, title, 2-line description |
| social | avatar + `@handle`, post text |
| book | cover + title + author + year |
| software | favicon + name + description |
| wiki / video / link | glyph + title + snippet |

Shared chrome: a small **type glyph/eyebrow in the accent colour** (so the kind
of source reads at a glance when zoomed out); an explicit **`↗ open`** hit-area
(opens `url` in a new tab — not whole-card click, which would fight tldraw's
select/drag; double-click stays "edit your annotation"); and **hover → full
metadata** (full authors, description, DOI/URL). References keep the muted source
look but with a hairline + favicon so they read as *external* vs. transcribed
notes.

## 3. Metadata engine — hybrid

The change-set op stays **pure data** (no network, no async) so the apply path is
identical on client and server. All fetching happens *before* the op is built.

**(a) App-side unfurl (instant baseline).** `POST /projects/:id/unfurl { url }`:
the server fetches the page, parses OpenGraph / oEmbed / Twitter-card / `<title>`
/ favicon (dependency-free), downloads favicon + hero into the project's
`assets/`, and returns a `Reference` draft. The parser and refType guesser are
pure functions with fixtures; the network+asset step wraps them. Fired when the
user **pastes/drops a URL**, or by the MCP tool.

**(b) Claude deepens.** The MCP `create_reference` tool calls `/unfurl` for the
baseline, then merges Claude's researched fields over it (authoritative
authors/year/venue/DOI for papers, from arXiv/Crossref/OpenAlex), and posts a
`create_reference` change-set carrying the final `Reference`. **Conflict rule:**
`fetchedBy` precedence `user > claude > unfurl`.

## 4. Claude's surface (minimal, composable)

One new op + tool does the work; the two headline workflows are documented in the
skill rather than baked into separate tools (YAGNI):

- **`create_reference(project, url, x, y, fields?)`** — create one reference
  card: unfurl baseline + merge Claude fields + post `create_reference`.
- **Enrich-in-place** (workflow): Claude reads a plain-text note naming sources,
  and for each source calls `create_reference` positioned just to the right of
  the note — **augmenting alongside, leaving the note untouched** (no data loss;
  a multi-source note spawns a small cluster).
- **Research → canvas** (workflow): Claude web-searches a topic, then calls
  `create_reference` for each chosen source clustered near a target card, and
  may drop a `create_section` label over the cluster.

`create_reference` writes only the `reference` object + creates a source card
(empty annotation `text`) → added to the `changeSetWritesText` allowlist
consciously, like the `edit_section_text` exception. It never writes annotation
text or prose.

## 5. Boundary & privacy

- **Boundary:** unchanged in spirit; the allowlist addition is narrow and
  documented. Claude writes bibliographic *facts*, never the user's words.
- **Privacy:** unfurl and Claude research make **outbound network requests** (to
  the source URL; to arXiv/Crossref/search), which crosses today's README line
  "nothing is sent anywhere". These are **explicit, per-action only** (you paste
  a link; you ask Claude) — never silent/background. The README privacy note is
  corrected to be precise: *your canvas stays local; enriching a public URL
  fetches that URL's metadata.*

## 6. Phasing

- **Phase A — reference card foundation:** model + `AddReference` migration,
  type-adaptive rendering, `↗ open`, hover metadata, `create_reference` op wired
  through client + server apply + digest.
- **Phase B — enrich-in-place (the heart):** `create_reference` MCP tool + skill.
- **Phase B′ — paste-to-unfurl:** `/unfurl` endpoint + client paste/drop + a
  `+ Link` toolbar affordance (the instant half of hybrid).
- **Phase C — research → canvas:** documented workflow over `create_reference`.
- **Later:** citation loop (`needs-citation` comment → attach a reference),
  reference→claim "supports" edges, references surviving Tana/MDX.

## 7. Testing

- **Unit:** reference factory + `AddReference` migration; `create_reference`
  validation + boundary (`changeSetWritesText` stays true for any user-text
  write); digest passes `reference` through; the OG/refType parser against HTML
  fixtures; the `create_reference` MCP tool posts the expected change-set.
- **E2e:** paste a URL → a reference card with title/favicon appears and `↗`
  opens it; a `create_reference` tool call renders a reference card in the open
  app, original note kept.
