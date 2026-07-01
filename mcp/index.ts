import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readCanvasTool, addCommentTool, mergeSourcesTool, moveCardsTool, createSourceCardTool } from './tools'

const COMMENT_TYPE = z.enum(['needs-evidence', 'weak-argument', 'needs-citation'])

export function createMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'elves', version: '0.1.0' })

  server.tool(
    'read_canvas',
    'Read the current canvas as a list of cards: id, kind (prose|source), text, x/y position (x is narrative order: left=earlier, right=later), comments, and mergedInto. Call this first to get card ids before commenting, merging, or moving.',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify(await readCanvasTool(baseUrl), null, 2) }] }),
  )

  server.tool(
    'add_comment',
    "Attach a comment to a card. Use a typed comment to flag a weakness in the user's PROSE (needs-evidence, weak-argument, needs-citation) or omit type for a freeform note. You never write or edit card text — only comments.",
    { cardId: z.string(), text: z.string(), type: COMMENT_TYPE.nullish() },
    async ({ cardId, text, type }) => {
      await addCommentTool(baseUrl, { cardId, text, type: type ?? null })
      return { content: [{ type: 'text', text: 'comment added' }] }
    },
  )

  server.tool(
    'merge_sources',
    'Collapse duplicate SOURCE cards into one. Pass the card ids to merge; the FIRST id is kept as the representative and the others are hidden (recoverable) under it. Source cards only.',
    { cardIds: z.array(z.string()).min(2) },
    async ({ cardIds }) => {
      await mergeSourcesTool(baseUrl, { cardIds })
      return { content: [{ type: 'text', text: 'sources merged' }] }
    },
  )

  server.tool(
    'move_cards',
    'Reposition cards. x is narrative order (smaller x = earlier in the piece). To bring a point earlier, move it to a smaller x than the points it should precede. Provide absolute x/y for each card.',
    { moves: z.array(z.object({ cardId: z.string(), x: z.number(), y: z.number() })).min(1) },
    async ({ moves }) => {
      await moveCardsTool(baseUrl, { moves })
      return { content: [{ type: 'text', text: 'cards moved' }] }
    },
  )

  server.tool(
    'create_source_card',
    "Create a SOURCE card containing text you transcribed from an image. First read the image card's file (read_canvas gives each image card an `assetPath`), then transcribe the handwriting FAITHFULLY — these are the user's own words; digitize them, do not summarize. Position (x, y) near the image. Creates a SOURCE card only — never a prose card.",
    { text: z.string(), x: z.number(), y: z.number() },
    async ({ text, x, y }) => {
      await createSourceCardTool(baseUrl, { text, x, y })
      return { content: [{ type: 'text', text: 'source card created' }] }
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
