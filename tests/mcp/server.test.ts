import { expect, test } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpServer } from '../../mcp/index'

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
    'create_figure_card',
    'create_note_card',
    'create_question',
    'create_reference',
    'create_section',
    'delete_card',
    'edit_figure_card',
    'edit_section_text',
    'group_cards',
    'list_projects',
    'merge_notes',
    'move_cards',
    'move_sections',
    'read_cards',
    'read_draft',
    'read_map',
    'ungroup_cards',
  ])
  expect(names).not.toContain('edit_text')
  expect(names).not.toContain('read_canvas')

  // Every canvas tool requires a `project`; list_projects does not.
  for (const t of tools) {
    const required = ((t.inputSchema as any).required ?? []) as string[]
    if (t.name === 'list_projects') expect(required).not.toContain('project')
    else expect(required).toContain('project')
  }

  await client.close()
})
