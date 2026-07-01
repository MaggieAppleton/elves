# Elves — Design Spec

- **Status:** Design approved, ready for implementation planning
- **Date:** 2026-07-01
- **Owner:** (you)
- **Related work:** "Augment Essay Submission" essay (Tana project `iNJ3uDCgxWuf`) — the first piece this tool will be used on.

---

## 1. Summary

**Elves** is a local-first, canvas-based writing studio for taking a piece from "drowning in scattered notes" to "a shaped set of my-own-voice points I can sit down and write from."

Ideas start scattered across Tana (voice-transcribed notes taken down in Claude's voice), physical paper, and iPad/Procreate sketches. Elves brings that raw material onto an infinite canvas as cards — images and typed notes in v1, with a careful Tana importer to follow — lets you spread everything out and rearrange it spatially (the way you already work — and the way John McPhee describes in *Draft No. 4*), and brings Claude onto the *same canvas* as a second participant with strictly different permissions: Claude organizes, dedupes, critiques, and annotates, but **never writes a single word of your prose.**

The tool is deliberately a small instance of the thesis of the essay it will first be used on: a canvas primitive + a Claude skill + deterministic boundaries, local-first — a piece of home-cooked, malleable software you reshape to fit you.

---

## 2. Goals & non-goals

### Goals (the MVP)
Cover **stages 1–4** of the writing pipeline end-to-end, for **one piece at a time**:

1. **Ingest** — images (photos of paper notes, Procreate exports) and typed source cards → cards on the canvas. Claude can help derive source cards from images. (Bulk import from Tana turned out to need more than a fixed rule can give — it's deferred to a separate assisted task; see §11.)
2. **Organize** — spread out, cluster, and rearrange cards spatially; Claude assists with dedupe/cluster/tag.
3. **Distill & critique** — write your own-voice points/prose; Claude flags gaps (evidence, counterargument, citation) and comments.
4. **Shape** — sequence the narrative *spatially* on the canvas (lanes, arrows, ordering) — never a forced linear outline.

### Non-goals (explicitly out of scope for v1)
- **Stage 5 — MDX / linear export.** Once the shape and seed-prose exist on the canvas, you'll write the final linear prose yourself in MDX in your website repo. Elves does not generate, own, or export the final document.
- **Live co-presence.** Collaboration is turn-based (you act; you ask Claude; Claude acts; the canvas refreshes). No real-time shared cursors.
- **Multi-device sync.** Single device for now. The data is a local file; syncing it across devices is a later concern.
- **Multiple pieces at once.** One canvas file = one piece.
- **Automated bulk import from Tana.** The Tana nodes for this project are used inconsistently — sometimes a parent + its children are one whole idea (→ a single source card), sometimes a single node packs several distinct ideas, sometimes one idea is spread across several nodes; and the parent/child structure encodes both grouping *and* a linear order that must not be lost. No fixed rule ("one node = one card") survives that. Import becomes its own assisted task, done later with Claude, not an upfront pipeline. The system is built to *hold* source cards (including a `Tana` origin badge); it just won't auto-generate them from Tana in v1.
- **Claude writing prose.** Not a feature that's disabled — a capability that structurally does not exist (see §5).

---

## 3. Core principles

These are the constraints that *define* the tool. Everything else is negotiable; these are not.

1. **Claude never writes your prose — structurally, not behaviourally.** The guarantee holds at the data-model and API level, not the "well-behaved assistant" level. Claude's tool set has no function that can write or edit the text of a prose card. (This mirrors the essay's own argument: restrictions should be enforceable, not left to stochastic chance.)
2. **Claude helps as a second layer over your work.** Import, research, synthesis, dedupe, structure critique, evidence/counterargument flags — a strengthening pass over what *you* wrote, never a replacement for writing it.
3. **Visual-first and canvas-native.** You think *on* the canvas. Cards are spread out, scrolled, grouped, and rearranged. There is no linear/outline view; you only go linear when you leave Elves to write the final MDX.
4. **Authorship is always visually distinguishable.** At a glance you can always tell your words from Claude's. Your prose is your typeface and styling; Claude's contributions (comments, flags) render as unmistakably Claude-authored.
5. **Local-first and yours.** The data is a plain file on your machine. The app is a small thing you own and can reshape.
6. **Design feel matters.** This is a designer's tool. Typography and visual polish are first-class requirements, not finishing touches — starting with your choice of the typeface cards render in.

---

## 4. User & workflow

**User:** a single writer/designer/illustrator who works visually, does heavy voice-transcription to think out loud, sketches arguments on paper and iPad, and publishes essays and conference talks as MDX on her own website. Technically fluent (works in JavaScript/web).

**The working process Elves supports:**

1. Dump all raw material onto the canvas — imported from Tana, dragged in as images, or typed straight in as source cards.
2. Spread it out, read across it, and start combining: "these two say the same thing → one point"; "these belong together." Deduplicate down toward the *canonical* points.
3. Write those canonical points in your own voice as **prose cards** — sometimes a bare point, sometimes a crafted sentence or paragraph.
4. Ask Claude to pressure-test: where's the evidence thin, where's the counterargument missing, where did I contradict an earlier note, what's duplicated.
5. Arrange the prose cards spatially into the *shape* of the piece — what comes before what, where the transitions are, where a visual will go.
6. Leave Elves with a clear shape and enough seed-prose to write the linear essay in MDX by hand.

---

## 5. Card model

Everything on the canvas is a card. There are two kinds, plus Claude's annotations.

### Source cards
Raw material. Reference only — **never** part of your prose. Visually muted/distinct from prose cards.

- **Flavours:** `text` or `image`.
- **Origin badge** (small, always visible so you know what you're looking at):
  - `Tana` — imported from your Tana graph; effectively in Claude's voice. Carries the source Tana node id as provenance.
  - `image` — a dropped photo of paper notes or a Procreate export.
  - `typed` — you transcribed/typed it directly into a source card.
- Claude may create source cards (including deriving text source cards from an image), and may dedupe, cluster, tag, flag, and comment on them.

### Prose cards
Your canonical material, in your voice. This is what the eventual essay is built from.

- Holds a **point**, a **sentence**, or a **paragraph** — your call, mixed freely.
- Rendered in **your chosen typeface**.
- **Text is human-write-only.** Only you, through the app's editor, can write or edit it.
- May reference the source cards it distills from (provenance in the other direction).
- Claude may flag, link, group, and comment on prose cards — but never edit their text.

### Claude comments
Claude can attach a comment to either card type. A comment renders as an **unmistakably Claude-styled note** — labelled, distinct colour, pinned to the card — so it can never be confused with your words. Your own notes, by contrast, are just cards (source or prose); there is no ambiguous shared text field.

---

## 6. The capability boundary

This is the heart of the tool: you and Claude operate the *same* canvas under *different* rules.

| Claude **can** | Claude **cannot** |
|---|---|
| Read the entire canvas (all cards, positions, groups, tags, flags, comments) | Write or edit the text of any **prose card** |
| Create **source** cards (typed, or derived from an image) | Create prose cards |
| Suggest dedupe/merge (as a proposal you accept or dismiss) | Auto-apply any merge, link, or move |
| Cluster, tag, and flag cards | — |
| Suggest links between cards | — |
| Comment on cards (rendered as Claude) | — |

Rules of the boundary:

- **Suggestions, not actions.** Merges, links, and re-groupings from Claude enter a *proposed* state. You accept or dismiss. Your material is never silently rewritten or destroyed.
- **Structural enforcement.** The boundary is enforced by the local server (§9), which simply exposes no tool that writes prose-card text. It is not a prompt Claude is asked to honour; it is a capability that does not exist in Claude's surface.
- **The human path is separate.** Writing prose is done by you, in the app's editor, over a write path that Claude's API never touches. Same file, two clients, different permissions.

### Flag vocabulary (starter set)
`evidence-gap` · `needs-counterargument` · `needs-citation` · `duplicate` (references its twin) · `contradiction-over-time` (links two cards where a later note reverses an earlier one). Extensible.

---

## 7. Ingest

### Typed source cards
- You can type a source card straight onto the canvas at any time (origin `typed`) — the simplest way to get a stray thought or a hand-copied note in.

### From images
- Drag a photo of paper notes or a Procreate export onto the canvas → it becomes an **image source card**, auto-tagged with the source symbol.
- On request, Claude reads the image (vision) and **proposes derived text source cards** from it — a faithful transcription of your handwriting, or the discrete points it can extract — which you review and accept. Derived cards are source cards (reference), so the never-writes-your-prose guarantee is untouched.

### From Tana — deferred (not built in v1)
Bulk import from Tana is intentionally **out of v1**. A fixed atomization rule is too brittle for how the nodes are actually used: a parent + its children are sometimes one whole idea (→ a single source card), other nodes pack several distinct ideas, and some ideas span several nodes — while the parent/child structure carries both grouping *and* a linear order worth preserving. That makes import its own **assisted task, done later with Claude**, not a pipeline to build upfront (see §11). The card model still reserves a `Tana` origin badge so imported cards slot in cleanly when that task happens.

---

## 8. Organize → distill → shape (stages 2–4)

- **Organize.** You cluster and arrange spatially. On request, Claude dedupes, clusters, and tags — always as suggestions.
- **Distill.** You write **prose cards** in your voice from clusters of source. Claude flags gaps (evidence, counterargument, citation) and comments; you decide what to act on.
- **Shape.** You sequence the narrative *spatially* — lanes, arrows, ordering on the canvas. There is no linear outline view. Claude may *point out* flow problems ("this point leans on one you've placed after it") as comments; the arranging is yours.

---

## 9. Architecture & tech

### Form factor
A small **local web app** plus a **Claude skill**. You run the app locally; you drive Claude turn-based from Claude Code (or another agent client) pointed at the project folder.

### Components
1. **Canvas app** — Vite + React + **tldraw**.
   - Cards are **custom tldraw shapes** (custom `ShapeUtil`), so they render as your own React components in **your chosen typeface** — not tldraw's hand-drawn default. The default sketchy chrome/theme is replaced.
   - The app is a renderer + *your* editor: it holds the human write path (create/edit prose cards, move, group, accept/dismiss Claude's suggestions).
2. **Local server** (Node) — owns the single source of truth, `canvas.json`, on disk.
   - Exposes a **scoped tool API** to Claude (the tools in §6, and pointedly *no* prose-writing tool). Natural fit: expose these as an **MCP server** so a coding agent can call them directly.
   - Serves the canvas app and pushes updates to it (e.g. over websocket) so the canvas **hot-reloads** when Claude changes the file.
   - **Is the enforcement point.** It validates every patch: Claude-originated patches may not modify prose-card text; the app's human path may.
3. **Claude skill** — instructions + the scoped tool set that teach Claude how to operate the canvas within its permissions (dedupe, cluster, flag, comment, derive source cards from images).

### Turn-based loop
You arrange cards in the app → you ask Claude (in Claude Code) to do something within its powers → Claude calls the server's tools → the server patches `canvas.json` → the app hot-reloads to show the change (suggestions appear in a proposed state for you to accept/dismiss).

### Data model (design sketch — details to be finalized in the implementation plan)
A card, conceptually:

```
Card {
  id
  type: "source" | "prose"
  // source only:
  sourceKind?: "text" | "image"
  origin?: { kind: "tana" | "image" | "typed", tanaNodeId?, importedAt? }
  // prose only:
  text?            // human-write-only
  sourceRefs?: id[] // which source cards this distills
  // shared:
  position, size
  groupId?
  tags: string[]
  flags: [ { type, note?, targetIds?, createdBy: "claude" } ]
  comments: [ { author: "claude", text, createdAt } ]
  links: [ { toId, kind: "suggested" | "accepted", createdBy } ]
}
```

`canvas.json` = the piece's metadata + the set of cards/groups/links (persisted alongside or within the tldraw store snapshot). Card metadata lives in custom-shape props so the canvas and the model stay in sync. The exact split between tldraw snapshot and Elves sidecar metadata is an implementation-plan decision; the invariant is that the server can validate provenance and authorship on every write.

---

## 10. Out of scope for v1
MDX / linear export · live co-presence · multi-device sync · multiple pieces at once · Claude authoring prose.

---

## 11. Future / open questions (post-MVP)
- **Tana bulk import (assisted):** a careful, assisted importer for a Tana subtree that respects how nodes are really used — collapsing parent+children into one source card where they're one idea, splitting multi-idea nodes, reassembling ideas spread across several nodes, and preserving parent/child grouping and linear order. Built later, with Claude, as its own task. This is the harder half of ingest and deliberately not in v1.
- **MDX bridge (stage 5):** a way to carry shaped prose cards + planned visual slots into MDX in the website repo.
- **Live co-presence (Model C):** watching Claude manipulate the canvas in real time.
- **Multi-device sync:** the local file synced across devices.
- **Multi-piece "studio":** many canvases; reuse of material and references across essays and talks.
- **Richer visual authoring:** first-class sketch/illustration cards and planned interactive-visual placeholders between points.

---

## 12. Decisions log (blessed during design)
- Build custom (not Heptabase/Obsidian/Muse/Scrivener). No off-the-shelf tool clears "AI critiques but never writes" + "output is my MDX."
- Canvas library: **tldraw**, with custom card shapes in a chosen typeface.
- Architecture: **Model A** — file-backed canvas + Claude skill; turn-based; **no** live co-presence.
- Two card types, using the user's terms: **source cards** and **prose cards**. Claude comments render distinctly.
- **Images are essential in v1**, tagged as source cards; Claude can derive source cards from images.
- Enforcement via a **tiny local Node server** owning the file (worth the small extra infra to make the boundary structural).
- **Tana bulk import deferred out of v1** — no fixed atomization rule (the nodes are used too inconsistently); it becomes a separate assisted import task done later with Claude. v1 ingest = typed source cards + images (with Claude vision deriving source cards).
- Starter flag vocabulary: evidence-gap · needs-counterargument · needs-citation · duplicate · contradiction-over-time.
- **One canvas file per piece.**
- Scope: **stages 1–4 only**; no MDX export in v1. **Multi-device sync dropped** from v1.
