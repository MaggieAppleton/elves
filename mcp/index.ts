import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  readCanvasTool,
  addCommentTool,
  mergeSourcesTool,
  moveCardsTool,
  createSourceCardTool,
  createReferenceTool,
  createSectionTool,
  moveSectionsTool,
  editSectionTextTool,
  listProjectsTool,
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
    'read_canvas',
    'Read a project\'s canvas as { cards, sections }. Cards: id, kind (prose|source), sourceKind (text|image|reference), text, x/y position (x is narrative order: left=earlier, right=later), comments, mergedInto, and — for reference cards — a `reference` object (url, refType, title, authors, year, venue, doi, …). Sections: id, text (a short thematic label), x/y, and authoredBy (user|claude — who wrote its current wording). Call this (with the project id) to get ids before commenting, merging, moving, renaming, or enriching mentions into references.',
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify(await readCanvasTool(baseUrl, project), null, 2) }],
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
    'merge_sources',
    'Collapse duplicate SOURCE cards in a project into one. Pass the card ids to merge; the FIRST id is kept as the representative and the others are hidden (recoverable) under it. Source cards only.',
    { project: PROJECT, cardIds: z.array(z.string()).min(2) },
    async ({ project, cardIds }) => {
      await mergeSourcesTool(baseUrl, project, { cardIds })
      return { content: [{ type: 'text', text: 'sources merged' }] }
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
    'create_source_card',
    "Create a SOURCE card in a project containing text you transcribed from an image. First read the image card's file (read_canvas gives each image card an `assetPath`), then transcribe the handwriting FAITHFULLY — these are the user's own words; digitize them, do not summarize. Position (x, y) near the image. Creates a SOURCE card only — never a prose card.",
    { project: PROJECT, text: z.string(), x: z.number(), y: z.number() },
    async ({ project, text, x, y }) => {
      await createSourceCardTool(baseUrl, project, { text, x, y })
      return { content: [{ type: 'text', text: 'source card created' }] }
    },
  )

  server.tool(
    'create_reference',
    "Create a REFERENCE source card from a url — a clickable, metadata-bearing card for an external source (paper, article, book, software, tweet/post, video, wiki, link). The server unfurls the url for a baseline (title, site, favicon, hero image, and citation metadata for papers); pass any fields you researched to override it — for an academic paper, look up authoritative `authors`, `year`, `venue`, and `doi` (e.g. via arXiv/Crossref) and pass them. Two main uses: (1) ENRICH a plain-text mention — read the note, and for EACH source it names call create_reference positioned just to the right of that note, leaving the note itself untouched (augment alongside, never delete). (2) RESEARCH a topic — find good sources and place them clustered near the card the user pointed at, optionally with a create_section label over them. x is narrative order like other cards. This creates a SOURCE card carrying reference facts; it never writes the user's prose or annotation.",
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

  return server
}

async function main() {
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
