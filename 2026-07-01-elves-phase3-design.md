# Elves Phase 3 — Design Spec (Images & Vision)

- **Status:** Design approved, ready for implementation planning
- **Date:** 2026-07-01
- **Builds on:** Phase 1 (canvas), Phase 2a (change-sets), Phase 2b (Claude via MCP). See the prior specs/plans in this repo.

---

## 1. Summary

Phase 3 brings **images** onto the Elves canvas. Two halves:

- **3a — image source cards:** drag a photo of paper notes or a Procreate/iPad sketch onto the canvas and it becomes an **image source card** — a visual artifact that lives on the canvas near the points it supports, and that drags and resizes like any card. This is the primary, human-only half.
- **3b — transcription:** for an image of *handwritten notes*, you can ask Claude to read it and it creates a **text source card** with a faithful transcription of your handwriting, placed next to the image. Optional, opt-in, Claude-side.

Faithful transcription is the one case where "Claude writes text" and "your words" coincide: Claude is a pen that can read your handwriting, not a composer. Transcribed notes land as **source** cards (reference you'll distill), so your **prose** cards stay 100% human.

---

## 2. Goals & non-goals

### Goals
- Drag/drop an image → an **image source card** (`sourceKind: 'image'`, `origin: 'image'`) that renders the image, sized to its aspect ratio, and moves/resizes.
- Store images **local-first as files on disk**, so the canvas stays a portable folder (`canvas.json` + `data/assets/`).
- Claude can **transcribe** a handwritten-notes image into a text source card (via a `create_source_card` op), faithfully, placed next to the image. Direct and undoable.
- The capability boundary holds: Claude may create **source** cards, but never creates/edits prose and never edits an existing card's text.

### Non-goals (deferred)
- Images becoming **essay visuals / MDX** — later, with the (still-deferred) MDX bridge.
- **Summarization/extraction** of images into Claude-voiced points — we chose faithful transcription; extraction is not built.
- Multi-image assets per card, image cropping/annotation tools, OCR of printed documents (this is handwriting via vision).
- Claude **uploading** images (Claude only reads/transcribes existing image cards; humans add images).
- Explicit transcript→image provenance links (positioning next to the image is the MVP link; a `derivedFrom` field is future).

---

## 3. Core principles

Carried from prior phases, plus Phase 3's refinement:

1. **Claude never writes your prose.** Refined for Phase 3: Claude may now **create source cards** (with transcribed text), but still **never creates or edits prose, and never edits an existing card's text.** Transcription is *your* handwriting digitized, landing as *source*.
2. **Everything Claude does is a tldraw store op → native Ctrl-Z undo** (transcription creates a source card via a change-set, undoable).
3. **Local-first.** Images are plain files on your machine; the canvas is a portable folder.
4. **Authorship stays distinguishable.** Image cards and transcribed text cards are **source**-styled (muted); your prose cards remain yours.

---

## 4. Image source cards (3a)

An image source card is the `image` flavour of a source card — not a new shape type.

- **Props:** `sourceKind: 'image'`, `origin: 'image'`, and a new `assetId: string | null` referencing the stored image. (`text` stays empty for image cards.)
- **Rendering:** the card renders the image (`object-fit: contain`) filling the card, with the muted source styling and an `image` origin badge. It drags and resizes like any card (resize works as of the recent fix).
- **Creation:** dropping an image file on the canvas uploads it (§5) and creates an image source card at the drop point, sized to the image's aspect ratio (capped to a sensible default width).

---

## 5. Storage (local-first)

- On drop, the app **POSTs the image bytes to the server** (`POST /assets`), which writes `data/assets/<id>.<ext>` and returns `{ assetId }`.
- The card stores `assetId`; the card component renders `<img src="{server}/assets/{assetId}">`.
- The server serves images at **`GET /assets/:id`**.
- This keeps `canvas.json` small and human-readable (no base64 blobs) and makes the canvas a portable **folder** (`canvas.json` + `data/assets/`). `data/` is already git-ignored.

---

## 6. Transcription (3b)

- **New op/tool `create_source_card`.** It creates a new **source** card (`sourceKind: 'text'`, `origin: 'transcribed'`) with the given text at a given position. Source only — it can never create a prose card.
- **How Claude sees the image:** `read_canvas` (`GET /cards`) exposes each image card's **local file path** (`assetPath`). When you ask Claude to transcribe, **Claude Code reads that image file with its native vision**, transcribes your handwriting as faithfully as possible, and calls `create_source_card` with the transcription, positioned next to the image.
- **Granularity:** one text source card per image by default; Claude may split into a few if the page clearly holds separate notes.
- **Direct + undoable:** the transcribed card appears live; one Ctrl-Z removes it.
- **Origin badge:** transcribed cards show a `transcribed` badge (a new value in the `origin` enum — additive, no migration needed since it only widens the allowed set).

---

## 7. The boundary, refined

- Claude's op vocabulary gains `create_source_card`. The `changeSetWritesText` guard is updated to **allow** `create_source_card` (it creates a new **source** card) while still rejecting anything that would write prose or edit an existing card's text (and still failing closed on unknown ops).
- The applier hardcodes `create_source_card` to produce `kind: 'source'` — there is no path by which it could create a prose card or set an existing card's text.
- `read_canvas` and the three existing ops are unchanged. Humans still own all prose; image upload is a human/app action (Claude never uploads).

---

## 8. Architecture (how it fits)

- **Server:** `POST /assets` (store bytes → file → `assetId`), `GET /assets/:id` (serve), and `GET /cards` digest includes `assetPath` for image cards.
- **App:** a drag/drop handler uploads the image and creates an image source card; the card component renders the image for `sourceKind: 'image'` cards.
- **Model / applier (3b):** `create_source_card` added to the `Op` union, the applier, and the `changeSetWritesText` guard; `origin` enum gains `transcribed`.
- **MCP (3b):** a `create_source_card` tool on the existing Elves MCP server; the digest already carries `assetPath`; the Claude skill gains the transcription workflow (read the image file, transcribe faithfully, create source cards next to it).
- **Data model:** one new card prop, `assetId` (with a shape-props migration defaulting it to `null`, like `comments`/`mergedInto`).

---

## 9. Sub-phasing (build order)

### Phase 3a — image source cards (no Claude)
Add the `assetId` prop + migration; `POST /assets` + `GET /assets/:id`; the drag/drop → upload → image source card flow; image rendering.
- **Done when:** dropping an image creates an image source card that renders the image, is stored as a file under `data/assets/`, moves/resizes, and persists across reload.

### Phase 3b — transcription (Claude)
Add `create_source_card` (op + applier + guard + MCP tool), `origin: 'transcribed'`, `assetPath` in the digest, and the skill's transcription workflow.
- **Done when:** from Claude Code, asking to transcribe an image reads the image file, creates a faithful-transcription text source card next to it (undoable), and `create_source_card` cannot create prose.

Build **3a first**; each is separately shippable and testable.

---

## 10. Out of scope for Phase 3
MDX / essay visuals · image→Claude-voiced summaries · image editing/cropping/annotation · printed-document OCR · Claude uploading images · explicit transcript↔image provenance links · multi-device.

---

## 11. Future
- Images as first-class **essay visuals** carried into MDX (with the MDX bridge).
- Explicit `derivedFrom` provenance linking a transcript to its image.
- Assisted **Tana import** (still deferred); MDX export; multi-device sync.

---

## 12. Decisions log (blessed during design)
- Images render as the **`image` flavour of source cards** (`sourceKind: 'image'`, `origin: 'image'`), not a new shape type.
- Derivation intent = **faithful transcription** of handwriting (not extraction/summary).
- Images are also **pure visual artifacts** — many sketches/diagrams live on the canvas near supporting points; transcription is opt-in per image.
- Storage = **image files in `data/assets/`**, server-served (`POST /assets`, `GET /assets/:id`); not base64 in `canvas.json`.
- Claude sees images via **Claude Code's native file Read** (path from `read_canvas`), not an MCP image-bytes tool.
- Transcription → **one source card per image** by default (Claude may split); **direct + undoable**.
- `create_source_card` creates **source only**; `changeSetWritesText` updated to permit it; prose stays 100% human.
- New card prop **`assetId`** (migration); `origin` enum gains **`transcribed`** (additive, no migration).
- Split into **3a (image cards) → 3b (transcription)**; build 3a first.
