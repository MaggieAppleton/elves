import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  readMapTool,
  readCardsTool,
  addCommentTool,
  mergeNotesTool,
  moveCardsTool,
  createNoteCardTool,
  createReferenceTool,
  createSectionTool,
  moveSectionsTool,
  editSectionTextTool,
  groupCardsTool,
  ungroupCardsTool,
  listProjectsTool,
  setAgentId,
} from './tools'

const COMMENT_TYPE = z.enum(['needs-evidence', 'weak-argument', 'needs-citation'])
const REF_TYPE = z.enum(['paper', 'article', 'book', 'software', 'social', 'video', 'wiki', 'link'])

// Every tool that touches a canvas requires this. Claude must know which project
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
    "Read a project's canvas MAP — the cheap, token-light first pass. Returns { cards, sections }. Each card is a small entry: id, kind (prose|note), noteKind (text|image|reference), x/y position (x is narrative order: left=earlier, right=later), `gist` (a one-line summary of the card — a model-authored summary for long cards, else the card's own short text), `textLen` (character count of the full text), and — when set — `mergedInto` and `refType`. It does NOT include full card text, comment bodies, or reference metadata. Sections: id, text (a short thematic label), x/y, authoredBy (user|claude). Groups: id, cardIds, memberCount, bounds — a set of cards bound to travel together (see group_cards); each grouped card also carries a `groupId`. Call this FIRST (with the project id) to see the shape of the piece and get ids; then call read_cards for the few cards you actually need in full before commenting, merging, moving, renaming, or enriching.",
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify(await readMapTool(baseUrl, project)) }],
    }),
  )

  server.tool(
    'read_cards',
    "Read the FULL content of specific cards by id (get the ids from read_map). Returns each card's kind, noteKind, origin, full `text`, x/y, `comments`, `mergedInto`, `assetPath` (image cards), `reference` (reference cards), and `summary`. Use this to drill into the handful of cards relevant to your task instead of pulling the whole canvas — read_map first, then read_cards for what matters.",
    { project: PROJECT, cardIds: z.array(z.string()).min(1) },
    async ({ project, cardIds }) => ({
      content: [{ type: 'text', text: JSON.stringify({ cards: await readCardsTool(baseUrl, project, cardIds) }) }],
    }),
  )

  server.tool(
    'add_comment',
    "Attach a comment to a card in a project. Use a typed comment to flag a weakness in the user's PROSE (needs-evidence, weak-argument, needs-citation) or omit type for a freeform note. You never write or edit card text — only comments.",
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
