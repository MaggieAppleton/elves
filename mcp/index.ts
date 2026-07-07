import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  readMapTool,
  readCardsTool,
  readDraftTool,
  addCommentTool,
  mergeNotesTool,
  moveCardsTool,
  createNoteCardTool,
  createReferenceTool,
  createSectionTool,
  createFigureCardTool,
  editCardTool,
  deleteCardTool,
  moveSectionsTool,
  editSectionTextTool,
  createQuestionTool,
  groupCardsTool,
  ungroupCardsTool,
  listProjectsTool,
  setAgentId,
} from './tools'

const COMMENT_TYPE = z.enum(['needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure'])
const REF_TYPE = z.enum(['paper', 'article', 'book', 'software', 'social', 'video', 'wiki', 'link'])

// Every tool that touches a canvas requires this. The agent must know which project
// it is working in before doing anything; if it doesn't, it calls list_projects
// and confirms with the user rather than guessing.
const PROJECT = z
  .string()
  .describe(
    "The project id to operate on (from list_projects). If you don't already know it, call list_projects first and confirm with the user — never guess.",
  )

export function createMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'elves', version: '0.1.0' })

  server.tool(
    'list_projects',
    'List the writing projects available in Elves as {id, name}. Call this first to discover project ids; every other tool requires a `project` id. If which project to work in is unclear, show these to the user and ask.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await listProjectsTool(baseUrl), null, 2) }] }),
  )

  server.tool(
    'read_map',
    "Read a project's canvas MAP — the cheap, token-light first pass. Returns { cards, sections, questions, groups }. Each card is a small entry: id, kind (prose|note|figure), noteKind (text|image|reference), x/y position (x is narrative order: left=earlier, right=later), `gist` (a one-line summary of the card — a model-authored summary for long cards, else the card's own short text; for a figure card the gist is its title), `textLen` (character count of the full text), and — when set — `mergedInto`, `refType`, and `figureStatus` (idea|sketched|final, on figure cards). It does NOT include full card text, comment bodies, or reference metadata. A `figure` card is a placeholder for a PLANNED VISUAL (see create_figure_card) — use the map to see which visuals are already planned so you don't suggest a duplicate. Sections: id, text (a short thematic label), x/y, authoredBy (`user`, or an agent id such as `claude`). Questions: id, text (a question you or another agent asked), x/y, authoredBy, and `dismissed` — the user hides a question once they've answered or waved it off; check these before asking, and NEVER re-ask a dismissed one (it's an answered \"no\"). Groups: id, cardIds, memberCount, bounds — a set of cards bound to travel together (see group_cards); each grouped card also carries a `groupId`. Call this FIRST (with the project id) to see the shape of the piece and get ids; then call read_cards for the few cards you actually need in full before commenting, merging, moving, renaming, questioning, or enriching.",
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify(await readMapTool(baseUrl, project)) }],
    }),
  )

  server.tool(
    'read_cards',
    "Read the FULL content of specific cards by id (get the ids from read_map). Returns each card's kind, noteKind, origin, full `text`, x/y, `comments`, `mergedInto`, `assetPath` (image cards), `reference` (reference cards), `figureTitle` + `figureStatus` (figure cards — the title, and the description in `text`), and `summary`. Use this to drill into the handful of cards relevant to your task instead of pulling the whole canvas — read_map first, then read_cards for what matters.",
    { project: PROJECT, cardIds: z.array(z.string()).min(1) },
    async ({ project, cardIds }) => ({
      content: [{ type: 'text', text: JSON.stringify({ cards: await readCardsTool(baseUrl, project, cardIds) }) }],
    }),
  )

  server.tool(
    'read_draft',
    "Read the project's canvas as a LINEAR DRAFT — the piece in true narrative order. Returns { blocks: [{ section, cards: [{ id, text }] }] }: sections run left→right as the order of the piece, and WITHIN each section cards run top→bottom. `section` is the heading text, or null for the opening block of cards that sit before the first section. Only PROSE cards compile (notes/images/references are excluded in v1); merged-away and draft-excluded cards are skipped. Prefer this over read_map when you are critiquing FLOW or narrative order: read_map gives positions and makes you re-derive the reading order yourself (and it can't tell you that top-to-bottom-within-a-section is the load-bearing convention) — read_draft hands you the order directly, with full card text. Use read_map/read_cards instead when you need positions, sizes, notes, references, or comments. Read-only.",
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify({ blocks: await readDraftTool(baseUrl, project) }) }],
    }),
  )

  server.tool(
    'add_comment',
    "Attach a comment to a card in a project. Use a typed comment to flag a weakness in the user's PROSE (needs-evidence, weak-argument, needs-citation), or `wants-figure` to point out a passage that would carry more as a visual (a spatial relationship described in words, a process/sequence, a comparison across several dimensions — anything the prose is straining to say linearly). Omit type for a freeform note. You never write or edit card text — only comments. (To drop an actual figure placeholder on the canvas, use create_figure_card.)",
    { project: PROJECT, cardId: z.string(), text: z.string(), type: COMMENT_TYPE.nullish() },
    async ({ project, cardId, text, type }) => {
      await addCommentTool(baseUrl, project, { cardId, text, type: type ?? null })
      return { content: [{ type: 'text', text: 'comment added' }] }
    },
  )

  server.tool(
    'merge_notes',
    'Collapse duplicate note cards in a project into one. Pass the card ids to merge; the FIRST id is kept as the representative and the others are hidden (recoverable) under it. Note cards only.',
    { project: PROJECT, cardIds: z.array(z.string()).min(2) },
    async ({ project, cardIds }) => {
      await mergeNotesTool(baseUrl, project, { cardIds })
      return { content: [{ type: 'text', text: 'notes merged' }] }
    },
  )

  server.tool(
    'move_cards',
    'Reposition cards in a project. x is narrative order (smaller x = earlier in the piece). To bring a point earlier, move it to a smaller x than the points it should precede. Provide absolute x/y for each card.',
    { project: PROJECT, moves: z.array(z.object({ cardId: z.string(), x: z.number(), y: z.number() })).min(1) },
    async ({ project, moves }) => {
      await moveCardsTool(baseUrl, project, { moves })
      return { content: [{ type: 'text', text: 'cards moved' }] }
    },
  )

  server.tool(
    'create_note_card',
    "Create a note card in a project containing text you transcribed from an image. First read the image card's file (read_cards gives each image card an `assetPath`), then transcribe the handwriting FAITHFULLY — these are the user's own words; digitize them, do not summarize. Position (x, y) near the image. Creates a note card only — never a prose card.",
    { project: PROJECT, text: z.string(), x: z.number(), y: z.number() },
    async ({ project, text, x, y }) => {
      await createNoteCardTool(baseUrl, project, { text, x, y })
      return { content: [{ type: 'text', text: 'note card created' }] }
    },
  )

  server.tool(
    'create_reference',
    "Create a REFERENCE note card from a url — a clickable, metadata-bearing card for an external source (paper, article, book, software, tweet/post, video, wiki, link). The server unfurls the url for a baseline (title, site, favicon, hero image, and citation metadata for papers); pass any fields you researched to override it — for an academic paper, look up authoritative `authors`, `year`, `venue`, and `doi` (e.g. via arXiv/Crossref) and pass them. Two main uses: (1) ENRICH a plain-text mention — read the note, and for EACH source it names call create_reference positioned just to the right of that note, leaving the note itself untouched (augment alongside, never delete). (2) RESEARCH a topic — find good sources and place them clustered near the card the user pointed at, optionally with a create_section label over them. x is narrative order like other cards. This creates a note card carrying reference facts; it never writes the user's prose or annotation.",
    {
      project: PROJECT,
      url: z.string().describe('The canonical url of the source (the link the card opens).'),
      x: z.number(),
      y: z.number(),
      refType: REF_TYPE.optional().describe('Override the guessed kind if you know better.'),
      title: z.string().optional(),
      authors: z.array(z.string()).optional().describe('Full author names; for papers, the authoritative list.'),
      year: z.number().optional(),
      venue: z.string().optional().describe('Conference/journal/publisher, e.g. "CHI 2025".'),
      description: z.string().optional().describe('A short abstract/summary or the post text.'),
      siteName: z.string().optional(),
      doi: z.string().optional(),
    },
    async ({ project, url, x, y, refType, title, authors, year, venue, description, siteName, doi }) => {
      await createReferenceTool(baseUrl, project, {
        url, x, y,
        fields: { refType, title, authors, year, venue, description, siteName, doi },
      })
      return { content: [{ type: 'text', text: 'reference card created' }] }
    },
  )

  server.tool(
    'create_section',
    'Create a section header in a project: a big thematic label (a few words) that sits above a cluster of cards so the shape of the piece reads at a glance when zoomed out. x is narrative order like cards — place it above/at the start of the cluster it labels. Unlike card text, you may write this directly; it renders in your accent color so the user can see you authored it.',
    { project: PROJECT, text: z.string(), x: z.number(), y: z.number() },
    async ({ project, text, x, y }) => {
      await createSectionTool(baseUrl, project, { text, x, y })
      return { content: [{ type: 'text', text: 'section created' }] }
    },
  )

  server.tool(
    'create_figure_card',
    "Drop a FIGURE CARD — a placeholder for a planned visual (illustration, diagram, interactive animation) — at its narrative position among the prose and notes. `title` is a short working title; `description` says, in a sentence or two, what the visual shows and the one contrast or structure that matters. Keep it SHORT and suggestive, not a spec — name the idea, don't storyboard it (avoid 'draw X on the left, label Y, then Z'); the user designs the actual figure, so over-prescribing just gets deleted. Suggest one where the prose would carry more as a picture: a spatial relationship described in words, a process or sequence, a comparison across more than two dimensions, or anything the text is straining to say linearly. It lands at status `idea` and renders with your authorship mark — your suggestion, the user's call to refine, keep, or delete (they own the actual illustration; you only plan it, never generate it). x is narrative order like other cards; place it beside the prose it would illustrate. First check read_map: if a figure is already planned there, don't add a duplicate. This writes a placeholder plan, never the user's prose.",
    { project: PROJECT, title: z.string(), description: z.string(), x: z.number(), y: z.number() },
    async ({ project, title, description, x, y }) => {
      await createFigureCardTool(baseUrl, project, { title, description, x, y })
      return { content: [{ type: 'text', text: 'figure card created' }] }
    },
  )

  server.tool(
    'edit_card',
    "Edit an existing WORKING-MATERIAL card in place — a note's body or a figure's description, via `text`; plus a figure's working `title` (figures only). Pass only the field(s) you want to change; omit the rest to leave them untouched. Get the cardId from read_map. This edits notes and figures, which are working material an agent helps maintain. It does NOT edit a PROSE card — that holds the user's own draft, theirs alone to write — nor a REFERENCE card's `text`, which is the user's own annotation; a reference's bibliographic facts are set once at creation and aren't editable here (recreate it to change them). Prefer this over delete + recreate — it keeps the card's id, position, and authorship mark.",
    { project: PROJECT, cardId: z.string(), text: z.string().optional(), title: z.string().optional() },
    async ({ project, cardId, text, title }) => {
      await editCardTool(baseUrl, project, { cardId, text, title })
      return { content: [{ type: 'text', text: 'card updated' }] }
    },
  )

  server.tool(
    'delete_card',
    "Delete a card YOU authored — a suggestion you dropped that the user wants gone: a figure placeholder, a note you transcribed, or one you're about to replace. Get the cardId from read_map. Scoped for safety: the server deletes a card only if it was agent-authored, so this can NEVER remove the user's own prose or notes — those stay theirs to delete by hand. Deletion is not reversible through the tools, so make sure the card is really yours to remove (check read_map/read_cards first). To fix a card's wording, prefer edit_card over delete + recreate.",
    { project: PROJECT, cardId: z.string() },
    async ({ project, cardId }) => {
      await deleteCardTool(baseUrl, project, { cardId })
      return { content: [{ type: 'text', text: 'card deleted' }] }
    },
  )

  server.tool(
    'move_sections',
    'Reposition section headers in a project. Same convention as move_cards — x is narrative order. Move a section along with the cluster of cards it labels so it keeps sitting above the right group.',
    { project: PROJECT, moves: z.array(z.object({ sectionId: z.string(), x: z.number(), y: z.number() })).min(1) },
    async ({ project, moves }) => {
      await moveSectionsTool(baseUrl, project, { moves })
      return { content: [{ type: 'text', text: 'sections moved' }] }
    },
  )

  server.tool(
    'edit_section_text',
    'Rename an existing section header — tighten its wording, or rename it after merging two sections into one. Section labels are organizational, not prose, so you may write this text directly. Never use this to write or edit a CARD\'s text — there is no tool for that, and there never will be.',
    { project: PROJECT, sectionId: z.string(), text: z.string() },
    async ({ project, sectionId, text }) => {
      await editSectionTextTool(baseUrl, project, { sectionId, text })
      return { content: [{ type: 'text', text: 'section renamed' }] }
    },
  )

  server.tool(
    'create_question',
    "Drop a QUESTION card near a cluster — a short, pointed question the way a good editor asks (\"What did the room smell like?\", \"You assert X in three places but never argue it — which card is the argument?\"). It provokes what the user hasn't written yet; they answer by writing their OWN cards beside it, then dismiss it. A question card holds ONLY a question, never draft prose — that's the point, and it keeps you inside the \"only the user writes the final prose\" rule. It renders in your accent with your authorship mark. Guidance: FEW and SPECIFIC — at most ~5 per pass; anchored in what the cards actually say, not generic writing advice; concrete beats abstract. Check existing questions in read_map FIRST (open AND dismissed) — a dismissed question is one the user already answered or waved off, so don't re-ask it. x is narrative order like cards; place it beside the cluster it interrogates.",
    { project: PROJECT, text: z.string(), x: z.number(), y: z.number() },
    async ({ project, text, x, y }) => {
      await createQuestionTool(baseUrl, project, { text, x, y })
      return { content: [{ type: 'text', text: 'question created' }] }
    },
  )

  server.tool(
    'group_cards',
    "Group cards so they TRAVEL TOGETHER on the canvas — a mechanical binding (a tldraw group), like selecting cards and choosing Group. Once grouped, moving any of them moves the whole set, so their spatial relationship is preserved when the piece is rearranged. Use it for cards that must stay adjacent: a note and the reference cards that annotate it (so the sources ride along with the note), or a tight narrative cluster. read_map already shows a `groups[]` list (each with its member cardIds and bounds) plus a `groupId` on each grouped card, so you can see what is already bound before adding more. Pass 2 or more card ids. The group carries no label or meaning — it is purely 'these move together'.",
    { project: PROJECT, cardIds: z.array(z.string()).min(2) },
    async ({ project, cardIds }) => {
      await groupCardsTool(baseUrl, project, { cardIds })
      return { content: [{ type: 'text', text: 'cards grouped' }] }
    },
  )

  server.tool(
    'ungroup_cards',
    'Dissolve a group so its cards move independently again. Pass the group id (from the `groups[]` list in read_map, or the `groupId` on a card). The cards keep their current positions; only the travel-together binding is removed.',
    { project: PROJECT, groupId: z.string() },
    async ({ project, groupId }) => {
      await ungroupCardsTool(baseUrl, project, { groupId })
      return { content: [{ type: 'text', text: 'cards ungrouped' }] }
    },
  )

  return server
}

async function main() {
  // This MCP process authors cards as one agent. Its id (stamped onto every note
  // it creates, driving the card's authorship mark) is configurable so other
  // agents — an OpenAI model, an open-source model — can run the same server and
  // mark their own notes: set ELVES_AGENT=openai. Defaults to 'claude'.
  setAgentId(process.env.ELVES_AGENT ?? 'claude')
  const server = createMcpServer(process.env.ELVES_URL ?? 'http://localhost:5199')
  await server.connect(new StdioServerTransport())
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  main().catch((err) => {
    console.error('Elves MCP server failed:', err)
    process.exit(1)
  })
}
