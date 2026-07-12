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

  await page.getByTestId('draft-open').click()
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')

  // Split: the pane has real width and the paragraph is on screen.
  await expect.poll(async () => (await pane.boundingBox())?.width ?? 0).toBeGreaterThan(200)
  const para = page.getByTestId('draft-para')
  await expect(para).toBeInViewport()
  await expect(para).toHaveText('the opening point')
})

test('editing a draft paragraph in draft-only view stays in the writing view', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await addProse(page, 'stay with me')
  await page.getByTestId('draft-open').click() // canvas → split
  await page.getByTestId('draft-expand').click() // split → draft (full)
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'draft')

  await page.getByTestId('draft-para').click()
  // Entering edit opens the inline editor without pulling the canvas back into
  // view — the isolated writing view stays put.
  await expect(page.getByTestId('draft-editor')).toBeVisible()
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'draft')
})

test('editing a paragraph in the draft rewrites the prose card on the canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const card = await addProse(page, 'first draft text')
  await page.getByTestId('draft-open').click() // canvas → split

  // Click the paragraph to open the inline editor.
  await page.getByTestId('draft-para').click()
  const editor = page.getByTestId('draft-editor')
  await expect(editor).toBeVisible()

  await editor.fill('rewritten from the linear view')

  // Same source text: the canvas card reflects the edit live.
  await expect(card.getByTestId('card-text')).toHaveText('rewritten from the linear view')

  // Blur commits/exits edit mode; the paragraph shows the new text.
  await page.mouse.click(50, 50)
  await expect(page.getByTestId('draft-editor')).toHaveCount(0)
  await expect(page.getByTestId('draft-para')).toHaveText('rewritten from the linear view')
})

test('copy as markdown writes the draft to the clipboard', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await addProse(page, 'a sentence to copy')
  await page.getByTestId('draft-open').click()

  await page.getByTestId('draft-copy').click()
  await expect(page.getByTestId('draft-copy')).toHaveText('Copied')
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('a sentence to copy')
})

test('the drawer chevrons step canvas → split → draft and back', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await addProse(page, 'round trip')

  const stage = page.locator('.elves-stage')
  await expect(stage).toHaveAttribute('data-view', 'canvas')

  await page.getByTestId('draft-open').click()
  await expect(stage).toHaveAttribute('data-view', 'split')

  await page.getByTestId('draft-expand').click()
  await expect(stage).toHaveAttribute('data-view', 'draft')

  await page.getByTestId('draft-collapse').click()
  await expect(stage).toHaveAttribute('data-view', 'split')

  await page.getByTestId('draft-collapse').click()
  await expect(stage).toHaveAttribute('data-view', 'canvas')
})
