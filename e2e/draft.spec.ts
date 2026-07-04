import { test, expect, type Page } from '@playwright/test'
import { resetProject } from './helpers'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

// Create a prose card and type `text` into it, committing the edit. Returns the
// card locator. Mirrors the pointer dance the other card specs use (tldraw
// routes pointer events through the canvas, so we click by page coordinates).
async function addProse(page: Page, text: string) {
  await page.getByTestId('new-prose').click()
  const card = page.locator('.elves-card--prose').last()
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  if (!box) throw new Error('prose card not in DOM')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.click(cx, cy)
  await page.mouse.dblclick(cx, cy)
  await page.locator('.elves-card__editor').fill(text)
  await page.mouse.click(50, 50) // commit
  await expect(card.getByTestId('card-text')).toHaveText(text)
  return card
}

test('a prose card shows up live in the draft pane in split view', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await addProse(page, 'the opening point')

  // Canvas-only: the draft pane is collapsed to zero width.
  const pane = page.locator('.elves-draft-pane')
  await expect.poll(async () => (await pane.boundingBox())?.width ?? -1).toBeLessThan(2)

  await page.getByTestId('view-split').click()
  await expect(page.getByTestId('view-split')).toHaveAttribute('data-active', 'true')

  // Split: the pane has real width and the paragraph is on screen.
  await expect.poll(async () => (await pane.boundingBox())?.width ?? 0).toBeGreaterThan(200)
  const para = page.getByTestId('draft-para')
  await expect(para).toBeInViewport()
  await expect(para).toHaveText('the opening point')
})

test('excluding a prose card drops it from the draft and marks it on the canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const card = await addProse(page, 'an aside, not the piece')
  await page.getByTestId('view-split').click()
  await expect(page.getByTestId('draft-para')).toHaveText('an aside, not the piece')

  // Select the card so its draft-exclude toggle appears, then exclude it.
  const box = await card.boundingBox()
  if (!box) throw new Error('card gone')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.getByTestId('draft-exclude-toggle').click()

  // Gone from the draft; marked as excluded on the canvas.
  await expect(page.getByTestId('draft-para')).toHaveCount(0)
  await expect(page.locator('.elves-card--excluded')).toBeVisible()
  await expect(page.getByTestId('draft-exclude-toggle')).toHaveAttribute('data-excluded', 'true')
})

test('clicking a draft paragraph in draft-only view opens split (draft → canvas nav)', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await addProse(page, 'jump to me')
  await page.getByTestId('view-draft').click()
  await expect(page.getByTestId('view-draft')).toHaveAttribute('data-active', 'true')

  await page.getByTestId('draft-para').click()
  // Navigation drops draft-only into split so the canvas is visible again.
  await expect(page.getByTestId('view-split')).toHaveAttribute('data-active', 'true')
})

test('copy as markdown writes the draft to the clipboard', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await addProse(page, 'a sentence to copy')
  await page.getByTestId('view-split').click()

  await page.getByTestId('draft-copy').click()
  await expect(page.getByTestId('draft-copy')).toHaveText('Copied')
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('a sentence to copy')
})
