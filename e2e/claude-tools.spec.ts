import { test, expect } from '@playwright/test'
import { addCommentTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('an MCP add_comment tool call lands as a comment in the open app', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()

  // Wait until the card is persisted so the tool's cross-check is satisfied.
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)

  await addCommentTool(BASE, projectId, { cardId, text: 'MCP says: no source', type: 'needs-evidence' })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('MCP says: no source')
})
