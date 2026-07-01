import { test, expect } from '@playwright/test'
import { addCommentTool } from '../mcp/tools'

const BASE = 'http://localhost:5199'

async function firstCardId(request: any): Promise<string> {
  const res = await request.get(`${BASE}/cards`)
  const cards = await res.json()
  return cards[0].id
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('an MCP add_comment tool call lands as a comment in the open app', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await page.waitForTimeout(800)

  const cardId = await firstCardId(request)
  await addCommentTool(BASE, { cardId, text: 'MCP says: no source', type: 'needs-evidence' })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('MCP says: no source')
})
