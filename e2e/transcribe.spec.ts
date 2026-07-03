import { test, expect } from '@playwright/test'
import { BASE, resetProject } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('create_note_card renders a transcribed note card, undoable', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(800) // let the realtime socket connect before posting

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: 't1', author: 'claude', ops: [
      { kind: 'create_note_card', text: 'my handwriting, typed', x: 200, y: 200 },
    ] },
  })

  const card = page.locator('.elves-card--note', { hasText: 'my handwriting, typed' })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('card-badge')).toHaveText('Note')

  await page.mouse.click(60, 300) // focus the canvas so Ctrl-Z reaches tldraw
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-card--note', { hasText: 'my handwriting, typed' })).toHaveCount(0)
})
