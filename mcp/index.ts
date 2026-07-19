import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PERSONALITIES, PERSONALITY_IDS } from '../src/model/reviews'
import {
  readMapTool,
  readCardsTool,
  readDraftTool,
  readSelectionTool,
  addCommentTool,
  listReviewsTool,
  startReviewTool,
  completeReviewTool,
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

const COMMENT_TYPE = z.enum([
  'needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure',
  'counterpoint', 'tighten', 'unclear', 'structure',
])
const PERSONALITY = z.enum(PERSONALITY_IDS as [string, ...string[]])
const REF_TYPE = z.enum(['paper', 'article', 'book', 'software', 'social', 'video', 'wiki', 'link'])

// Every tool that touches a canvas requires this. The agent must know which project
// it is working in before doing anything; if it doesn't, it calls list_projects
// and confirms with the user rather than guessing.
const PROJECT = z
  .string()
  .describe(
    "The project id to operate on (from list_projects). If you don't already know it, call list_projects first and confirm with the user — never guess.",
  )

// House style handed to EVERY agent that connects (Claude or otherwise), sent
// once in the MCP initialize handshake so it colors every tool call — not just
// this server's. The canvas is the user's draft; an agent works in its margins,
// so the governing rule is brevity: everything you leave on the canvas is a
// sticky note, never an essay.
const INSTRUCTIONS = `You are a collaborator in the margins of someone's writing project — a canvas of cards holding their draft. The user writes the prose; you leave the marginalia: comments, questions, section labels, figure suggestions, reference cards.

The one house rule, non-negotiable: ONE SENTENCE. Every comment, question, and figure description is a single sentence — two only if the first truly cannot stand alone, and never more. Reply with only the note itself: no preamble, no "I noticed that...", no throat-clearing — say the one thing that matters and stop. A wall of text in the margin is worse than silence — the user skims it and loses trust in the rest.

Be sparing as well as brief: a few pointed notes beat a dozen, and one precise question beats five vague ones. You annotate and suggest; you never write the user's prose for them.

The user can also summon a REVIEW PASS — a bounded, in-character editorial read by one of five personalities (Devil's Advocate, Fact-Checker, Trimmer, First Reader, Architect). When you start work on a canvas, check list_reviews: a pending review is the user's summons waiting for you — claim it with start_review and follow the brief it returns. If the user asks for that kind of read in chat ("play devil's advocate on this"), open the pass with start_review(personality) instead of free-styling, so their review panel shows the pass and groups your notes.`

export function createMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'elves', version: '0.1.0' }, { instructions: INSTRUCTIONS })

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
    "Read the project's canvas as a LINEAR DRAFT — the piece in true narrative order. Returns { blocks: [{ section, items }] }: sections run left→right as the order of the piece, and WITHIN each section draft items run top→bottom. `items` contains prose paragraphs ({ type:'prose', id, text }), planned figures ({ type:'figure', id, title, description, status }), and image cards ({ type:'image', id, assetId }) in the exact reading order. `section` is the heading text, or null for the opening block of items that sit before the first section. Merged-away and draft-excluded cards are skipped. Prefer this over read_map when you are critiquing FLOW or narrative order: read_map gives positions and makes you re-derive the reading order yourself (and it can't tell you that top-to-bottom-within-a-section is the load-bearing convention) — read_draft hands you the order directly, including visuals. Use read_map/read_cards instead when you need positions, sizes, references, comments, or resolved image file paths. Read-only.",
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify({ blocks: await readDraftTool(baseUrl, project) }) }],
    }),
  )

  server.tool(
    'read_selection',
    "Read what the user currently has SELECTED on the canvas. Call this FIRST whenever the user refers to their selection deictically — \"this\", \"these\", \"here\", \"the selected card(s)\", \"what I've got highlighted\" — where the referent is on the canvas, not in the chat. Takes NO arguments: it returns which `project` the selection is in, so you can resolve \"find more about this\" without knowing the project first (then use that id for read_cards, create_reference, etc.). Returns { project, selection, selectedAt }: `selection` is the selected shapes in the order the user picked them — each a card ({ id, type:'card', kind, gist }), a section ({ type:'section', text }), a question ({ type:'question', text }), or a group ({ type:'group', memberCount }). `gist` is a one-line summary (as in read_map); drill into full card text with read_cards. `selectedAt` is when the selection was made (ISO) — if it's old relative to the conversation, the user may have moved on, so confirm rather than assume. An empty `selection` (and absent `project`) means nothing is selected right now — ask the user what they mean rather than guessing.",
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await readSelectionTool(baseUrl)) }],
    }),
  )

  server.tool(
    'add_comment',
    "Attach a comment to a card in a project. Use a typed comment to flag a weakness in the user's PROSE (needs-evidence, weak-argument, needs-citation, counterpoint, tighten, unclear, structure), or `wants-figure` to point out a passage that would carry more as a visual. Omit type for a freeform note. ONE sentence — two only if truly necessary, never more. Reply with only the note itself: no preamble, no hedging. Pass reviewId during a review pass so the panel can group its notes. You never write or edit card text — only comments. (To drop an actual figure placeholder on the canvas, use create_figure_card.)",
    {
      project: PROJECT,
      cardId: z.string(),
      text: z.string(),
      type: COMMENT_TYPE.nullish(),
      reviewId: z.string().nullish().describe(
        'The review pass this comment belongs to (from start_review). REQUIRED during a review pass so the panel can group its notes; omit for a one-off comment outside any pass.',
      ),
    },
    async ({ project, cardId, text, type, reviewId }) => {
      await addCommentTool(baseUrl, project, { cardId, text, type: type ?? null, reviewId: reviewId ?? null })
      return { content: [{ type: 'text', text: 'comment added' }] }
    },
  )

  server.tool(
    'list_reviews',
    "List a project's REVIEW PASSES — bounded, in-character editorial reads by a summoned personality (devils-advocate | fact-checker | trimmer | first-reader | architect). Returns each pass's id, personality, status (pending | in-progress | done | dismissed), focus (the user's optional scope note), agent, verdict, and commentCount. A PENDING review is the user's summons from the app waiting for an agent: when you start work on a canvas — or whenever the user asks 'any reviews waiting?' — check this and claim pending passes with start_review(reviewId). Never re-run a done pass unprompted, and treat a dismissed one as waved off.",
    { project: PROJECT },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify({ reviews: await listReviewsTool(baseUrl, project) }) }],
    }),
  )

  server.tool(
    'start_review',
    "Open a REVIEW PASS and receive its working brief. Two ways in: pass `reviewId` to CLAIM a pending pass the user summoned from the app (from list_reviews — always check for one first), or pass `personality` to start an ad-hoc pass when the user asks for that kind of read in chat ('play devil's advocate', 'where do I need citations?', 'help me tighten this', 'read it cold', 'check the structure'). Never open an ad-hoc pass when a pending one of the same personality is waiting — claim it instead. Returns { reviewId, personality, focus, instructions }: follow the instructions exactly — read the draft first, stay in character, respect the comment/question budgets, tag EVERY comment with the reviewId — then finish with complete_review. The five personalities: devils-advocate (argues back: counterpoints, weak reasoning), fact-checker (unsupported claims, missing citations), trimmer (concision: what to compress, never rewrites), first-reader (a cold reader's confusion), architect (structure: order, bridges, shape).",
    {
      project: PROJECT,
      reviewId: z.string().optional().describe('A pending review to claim, from list_reviews.'),
      personality: PERSONALITY.optional().describe('Start an ad-hoc pass as this personality (when there is no pending review to claim).'),
      focus: z.string().optional().describe("Optional scope for an ad-hoc pass, from the user's ask ('just the intro'). Ignored when claiming by reviewId — the user already set the focus when summoning."),
    },
    async ({ project, reviewId, personality, focus }) => ({
      content: [{
        type: 'text',
        text: JSON.stringify(await startReviewTool(baseUrl, project, {
          reviewId,
          personality: personality as (typeof PERSONALITY_IDS)[number] | undefined,
          focus: focus ?? null,
        })),
      }],
    }),
  )

  server.tool(
    'complete_review',
    "Close a review pass with your VERDICT: one to three sentences of honest overall read — the through-line of what you found, including 'this holds up' when it does. The verdict appears in the user's review panel (don't also leave it as a comment). Call this exactly once, after your last comment/question of the pass; the server stamps the pass's comment count at this moment. Also tell the user the verdict in chat.",
    { project: PROJECT, reviewId: z.string(), verdict: z.string() },
    async ({ project, reviewId, verdict }) => {
      const review = await completeReviewTool(baseUrl, project, { reviewId, verdict })
      return {
        content: [{
          type: 'text',
          text: `review complete — ${review.commentCount} comment${review.commentCount === 1 ? '' : 's'} in this pass`,
        }],
      }
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
    "Drop a FIGURE CARD — a placeholder for a planned visual (illustration, diagram, interactive animation) — at its narrative position among the prose and notes. `title` is a short working title; `description` names the idea in ONE sentence — two at most, never more: what the visual shows and the one contrast or structure that matters. No preamble, no spec — name the idea, don't storyboard it (avoid 'draw X on the left, label Y, then Z'); the user designs the actual figure, so over-prescribing just gets deleted. Suggest one where the prose would carry more as a picture: a spatial relationship described in words, a process or sequence, a comparison across more than two dimensions, or anything the text is straining to say linearly. It lands at status `idea` and renders with your authorship mark — your suggestion, the user's call to refine, keep, or delete (they own the actual illustration; you only plan it, never generate it). x is narrative order like other cards; place it beside the prose it would illustrate. First check read_map: if a figure is already planned there, don't add a duplicate. This writes a placeholder plan, never the user's prose.",
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
    "Drop a QUESTION card near a cluster — a short, pointed question the way a good editor asks (\"What did the room smell like?\", \"You assert X in three places but never argue it — which card is the argument?\"). It provokes what the user hasn't written yet; they answer by writing their OWN cards beside it, then dismiss it. A question card holds ONLY a question, never draft prose — that's the point, and it keeps you inside the \"only the user writes the final prose\" rule. It renders in your accent with your authorship mark. Guidance: ONE sentence per question, no preamble — just ask it, never more than one. FEW and SPECIFIC — at most ~5 per pass; anchored in what the cards actually say, not generic writing advice; concrete beats abstract. Check existing questions in read_map FIRST (open AND dismissed) — a dismissed question is one the user already answered or waved off, so don't re-ask it. x is narrative order like cards; place it beside the cluster it interrogates.",
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

  // One prompt per personality, so an MCP client that surfaces prompts (e.g.
  // slash commands in Claude Code) can summon a review pass without the app UI:
  // the prompt walks the agent through the same start_review → brief →
  // complete_review loop the panel-summoned path uses, one record type for both.
  for (const id of PERSONALITY_IDS) {
    const p = PERSONALITIES[id]
    server.registerPrompt(
      id,
      {
        title: `${p.name} review pass`,
        description: `${p.summary} A bounded, in-character editorial pass over the canvas; annotates only, never writes prose.`,
        argsSchema: {
          project: z.string().optional().describe('The Elves project id to review (from list_projects). Omit to be asked.'),
          focus: z.string().optional().describe("Optional scope for the pass, e.g. 'just the opening section'."),
        },
      },
      ({ project, focus }) => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Summon ${p.name} for a review pass on my Elves canvas.

1. Pick the project: ${project ? `use '${project}'.` : 'call list_projects and confirm with me if it is ambiguous.'}
2. Check list_reviews first — if a pending '${id}' pass is already waiting, claim it with start_review(reviewId); otherwise open an ad-hoc pass with start_review(personality: '${id}'${focus ? `, focus: ${JSON.stringify(focus)}` : ''}).
3. Follow the brief it returns exactly: read the draft first, stay in character, respect the budgets, and tag every comment with the pass's reviewId.
4. Finish with complete_review and tell me the verdict here.`,
          },
        }],
      }),
    )
  }

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
