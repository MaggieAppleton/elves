import { beforeEach, expect, test } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpServer, setRepairer } from '../../mcp/index'
import type { Repairer } from '../../mcp/repair'
import type { StyleHit } from '../../src/model/houseStyle'

/** A repairer that never repairs — the behaviour when Ollama is not running.
 * The default is the real OllamaRepairer, which would make this suite depend on
 * a local model being up, take seconds per case, and vary with the model's
 * mood. Tests drive the gate through an explicit stub instead. */
const NO_REPAIR: Repairer = {
  label: 'test/none',
  async repair() {
    return null
  },
}

/** A repairer that always succeeds, returning a fixed clean note. */
function fixedRepair(text: string): Repairer {
  return {
    label: 'test/fixed',
    async repair(_original: string, _hits: StyleHit[]) {
      return { text, attempts: 1 }
    },
  }
}

beforeEach(() => setRepairer(NO_REPAIR))

test('the MCP server exposes the scoped tools plus list_projects, and no text-editing tool', async () => {
  const server = createMcpServer('http://localhost:5199')
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientT)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  expect(names).toEqual([
    'add_comment',
    'complete_review',
    'create_feedback',
    'create_figure_card',
    'create_note_card',
    'create_question',
    'create_reference',
    'create_section',
    'delete_card',
    'edit_card',
    'edit_section_text',
    'group_cards',
    'list_projects',
    'list_reviews',
    'merge_notes',
    'move_cards',
    'move_sections',
    'read_cards',
    'read_draft',
    'read_map',
    'read_selection',
    'resolve_feedback',
    'start_review',
    'ungroup_cards',
  ])
  expect(names).not.toContain('edit_text')
  expect(names).not.toContain('read_canvas')

  // Every canvas tool requires a `project`; the projectless tools (list_projects,
  // and read_selection — which reports which project the selection is in) do not.
  const projectless = new Set(['list_projects', 'read_selection'])
  for (const t of tools) {
    const required = ((t.inputSchema as any).required ?? []) as string[]
    if (projectless.has(t.name)) expect(required).not.toContain('project')
    else expect(required).toContain('project')
  }

  await client.close()
})

// The house-style gate runs in the tool handler, before anything is sent over
// the wire, so these drive it against a deliberately dead base url: a call that
// is rejected never reaches the network, and a call that gets past the gate
// fails with a connection error instead. That difference is the assertion.
const DEAD = 'http://127.0.0.1:1'

async function connectClient() {
  const server = createMcpServer(DEAD)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientT)
  return client
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: { text: string }[]
    }
    return { isError: Boolean(res.isError), text: res.content.map((c) => c.text).join('\n') }
  } catch (err) {
    // A connection refusal surfaces as a thrown protocol error; for these tests
    // that counts as "the gate let it through".
    return { isError: true, text: String(err) }
  }
}

test('the initialize handshake hands every agent the house style', async () => {
  const client = await connectClient()
  const instructions = client.getInstructions() ?? ''
  expect(instructions).toContain('HOUSE STYLE')
  expect(instructions).toContain("it's worth noting")
  expect(instructions).toContain('backticks')
  await client.close()
})

const SLOP = "It's worth noting that this claim plays a crucial role."

const GATED: [string, Record<string, unknown>, string][] = [
  ['add_comment', { project: 'p', cardId: 'c', text: SLOP }, 'comment'],
  ['create_question', { project: 'p', text: SLOP, x: 0, y: 0 }, 'question'],
  ['create_feedback', { project: 'p', text: SLOP, x: 0, y: 0 }, 'feedback note'],
  ['create_section', { project: 'p', text: 'The ever-evolving landscape', x: 0, y: 0 }, 'section label'],
  ['edit_section_text', { project: 'p', sectionId: 's', text: 'A vibrant tapestry' }, 'section label'],
  ['create_figure_card', { project: 'p', title: 'T', description: SLOP, x: 0, y: 0 }, 'figure description'],
  ['edit_card', { project: 'p', cardId: 'c', title: 'A seamless tapestry' }, 'figure title'],
  ['complete_review', { project: 'p', reviewId: 'r', verdict: SLOP }, 'verdict'],
]

for (const [tool, args, field] of GATED) {
  test(`${tool} rejects slop before it can reach the canvas`, async () => {
    const client = await connectClient()
    const { isError, text } = await callText(client, tool, args)
    expect(isError).toBe(true)
    expect(text).toContain(`this ${field} hits`)
    expect(text).toContain('house-style')
    await client.close()
  })
}

test('a rejection names the rule and quotes the phrase, so the agent can fix it', async () => {
  const client = await connectClient()
  const { text } = await callText(client, 'add_comment', { project: 'p', cardId: 'c', text: SLOP })
  expect(text).toContain('didactic-hedge')
  expect(text).toContain('inflated-role')
  expect(text).toContain('plays a crucial role')
  expect(text).toContain('call the tool again')
  await client.close()
})

test('a clean note gets past the gate', async () => {
  const client = await connectClient()
  const { text } = await callText(client, 'add_comment', {
    project: 'p',
    cardId: 'c',
    text: 'The 73% figure has no source.',
  })
  // It still fails — nothing is listening on the dead port — but not on style.
  expect(text).not.toContain('house-style')
  await client.close()
})

test('a figure title is checked as well as its description', async () => {
  const client = await connectClient()
  const { text } = await callText(client, 'create_figure_card', {
    project: 'p',
    title: 'The intricate interplay',
    description: 'Three layers, and where the write path crosses them.',
    x: 0,
    y: 0,
  })
  expect(text).toContain('this figure title hits')
  expect(text).toContain('ai-vocab')
  await client.close()
})

test("transcription is never style-checked — those are the user's own words", async () => {
  // create_note_card digitizes handwriting. Tidying it would be rewriting the
  // user's notes, which is the one thing an Elves agent must never do.
  const client = await connectClient()
  const { text } = await callText(client, 'create_note_card', {
    project: 'p',
    text: "It's worth noting that I delve into the intricate tapestry here.",
    x: 0,
    y: 0,
  })
  expect(text).not.toContain('house-style')
  await client.close()
})

test("edit_card's body is never style-checked — it may be the user's own words", async () => {
  // `text` on a note card is handwriting the agent transcribed, or something
  // the user typed herself. The tool cannot tell a note from a figure without a
  // read, and grading her words is worse than missing a stale description.
  const client = await connectClient()
  const { text } = await callText(client, 'edit_card', {
    project: 'p',
    cardId: 'c',
    text: "It's worth noting that I delve into the intricate tapestry here.",
  })
  expect(text).not.toContain('house-style')
  await client.close()
})

test('reference fields are never style-checked — those are the source\'s facts', async () => {
  const client = await connectClient()
  const { text } = await callText(client, 'create_reference', {
    project: 'p',
    url: 'https://example.com/paper',
    x: 0,
    y: 0,
    description: 'A meticulous study of the intricate interplay between seamless systems.',
  })
  expect(text).not.toContain('house-style')
  await client.close()
})

test('a note the local model repairs is accepted, not rejected', async () => {
  setRepairer(fixedRepair('This claim needs a source.'))
  const client = await connectClient()
  const { text } = await callText(client, 'add_comment', {
    project: 'p',
    cardId: 'c',
    text: SLOP,
  })
  // It got past the gate — the failure is the dead port, not the style check.
  expect(text).not.toContain('house-style')
  await client.close()
})

test('a repair is reported back to the agent rather than made silently', async () => {
  // The card keeps the agent's authorship mark, so it is told what a different
  // model changed under it — and, being told, tends not to need telling twice.
  setRepairer(fixedRepair('The middle sags.'))
  const client = await connectClient()
  const { text } = await callText(client, 'create_feedback', {
    project: 'p', text: "Here's the thing: the middle sags.", x: 0, y: 0,
  })
  // The write itself still fails on the dead port; what matters is that the
  // gate chose to repair, so the message is not a style rejection.
  expect(text).not.toContain('Rejected:')
  await client.close()
})

test('the gate falls back to rejecting when the local model is unreachable', async () => {
  // Ollama not running is the common case on a fresh machine. The old
  // behaviour has to survive it intact.
  setRepairer(NO_REPAIR)
  const client = await connectClient()
  const { isError, text } = await callText(client, 'add_comment', {
    project: 'p', cardId: 'c', text: SLOP,
  })
  expect(isError).toBe(true)
  expect(text).toContain('this comment hits')
  expect(text).toContain('didactic-hedge')
  await client.close()
})

test('the gate passes a value through unchanged when it has nothing to check', async () => {
  // An empty string is valid per the schema and the gate does not examine it,
  // so it must arrive downstream as the empty string — not as a missing
  // argument. A gate that does not read a value must not alter it.
  const client = await connectClient()
  const { text } = await callText(client, 'add_comment', { project: 'p', cardId: 'c', text: '' })
  expect(text).not.toContain('house-style')
  // The call reached the transport (and failed on the dead port) rather than
  // being mangled into a malformed request before it got there.
  expect(text).not.toContain('undefined')
  await client.close()
})

test("quoting the user's prose passes the gate", async () => {
  const client = await connectClient()
  const { text } = await callText(client, 'add_comment', {
    project: 'p',
    cardId: 'c',
    text: 'Cut "it\'s worth noting that" from the opening.',
  })
  expect(text).not.toContain('house-style')
  await client.close()
})
