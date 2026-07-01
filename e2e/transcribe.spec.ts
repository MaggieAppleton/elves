import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('create_source_card renders a transcribed source card, undoable', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(800) // let the realtime socket connect before posting

  await request.post(`${BASE}/changeset`, {
    data: { id: 't1', author: 'claude', ops: [
      { kind: 'create_source_card', text: 'my handwriting, typed', x: 200, y: 200 },
    ] },
  })

  const card = page.locator('.elves-card--source', { hasText: 'my handwriting, typed' })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('card-badge')).toHaveText('transcribed')

  await page.mouse.click(60, 300) // focus the canvas so Ctrl-Z reaches tldraw
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-card--source', { hasText: 'my handwriting, typed' })).toHaveCount(0)
})
