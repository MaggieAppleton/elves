import { test, expect } from '@playwright/test'
import { createNoteCardTool, readCardsTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

// End-to-end proof of the agent-presence glow: an MCP action / read on the
// server must broadcast over the socket and light up the right card in the open
// tab. Covers both signals — "doing" (a change-set landed) and "looking"
// (read_cards) — through the real server → WebSocket → canvas path.

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('a card the agent creates glows as "doing" presence', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Claude creates a note through the MCP; the open tab applies the change-set
  // and glows the freshly-minted card.
  await createNoteCardTool(BASE, projectId, { text: 'freshly made note', x: 140, y: 140 })

  const card = page.locator('.elves-card--note', { hasText: 'freshly made note' })
  await expect(card).toBeVisible({ timeout: 15000 })
  // The wrap is the card's PARENT; assert the glowing wrap is the one holding
  // this card's text. Generous timeout: the create must round-trip
  // server → WebSocket → render, which can lag under full-suite load.
  await expect(
    page.locator('.elves-card-wrap[data-presence="doing"]', { hasText: 'freshly made note' }),
  ).toBeVisible({ timeout: 15000 })
})

test('reading a card via the MCP glows it as "looking" presence', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()

  // Wait until the card is persisted so read_cards resolves against it.
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)

  // read_cards on a specific id is the agent "looking" — the tab lights it up.
  await readCardsTool(BASE, projectId, [cardId])

  await expect(page.locator('.elves-card-wrap[data-presence="looking"]')).toBeVisible({ timeout: 15000 })
})
