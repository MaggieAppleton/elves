import { test, expect } from '@playwright/test'
import { readSelectionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

// End-to-end proof of the selection loop: what the user selects in the open tab
// must travel browser → server → the MCP read_selection tool, so the agent can
// resolve "this" / "these". The mirror image of the presence spec (which proves
// the other direction, agent → canvas glow).

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('a card selected in the tab is visible to read_selection, with its project', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // A new prose card lands selected (and in edit mode) — that selection is what
  // we expect to see surface through the tool.
  await page.getByTestId('new-prose').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)

  // Poll the MCP tool: after the report debounce round-trips, the selection
  // shows this card, tagged with the project it lives in.
  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.map((s) => s.id), { timeout: 15000 })
    .toEqual([cardId])

  const result = await readSelectionTool(BASE)
  expect(result.project).toBe(projectId)
  expect(result.selection[0]).toMatchObject({ id: cardId, type: 'card' })
  expect(typeof result.selectedAt).toBe('string')
})

test('deselecting (clicking empty canvas) reports an empty selection', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)
  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.map((s) => s.id), { timeout: 15000 })
    .toEqual([cardId])

  // Escape leaves edit mode, then a click on empty canvas clears the selection.
  await page.keyboard.press('Escape')
  await page.locator('.tl-canvas').click({ position: { x: 8, y: 8 } })

  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.length, { timeout: 15000 })
    .toBe(0)
})
