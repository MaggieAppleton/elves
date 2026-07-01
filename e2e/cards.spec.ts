import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  // Reset the shared canvas so tests don't bleed into each other.
  await request.post('http://localhost:5199/canvas', {
    data: { document: null, session: null },
  })
})

test('create a prose card, type into it, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  const card = page.locator('.elves-card--prose').first()
  await expect(card).toBeVisible()

  // tldraw routes pointer events through its own state machine via the canvas.
  // Use mouse coordinates at the card's bounding box center rather than
  // clicking the DOM element directly (which is blocked by .tl-background).
  const box = await card.boundingBox()
  if (!box) throw new Error('card not found in DOM')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Single-click to select, then double-click to enter edit mode.
  await page.mouse.click(cx, cy)
  await page.mouse.dblclick(cx, cy)

  await page.locator('.elves-card__editor').fill('composition was the bottleneck')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(card.getByTestId('card-text')).toHaveText('composition was the bottleneck')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  await expect(
    page.locator('.elves-card--prose').getByText('composition was the bottleneck'),
  ).toBeVisible({ timeout: 15000 })
})

test('source card is muted and shows its origin badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-source').click()
  const source = page.locator('.elves-card--source').first()
  await expect(source).toBeVisible()
  await expect(source.getByTestId('card-badge')).toHaveText('typed')
})
