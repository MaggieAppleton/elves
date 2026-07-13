import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  // Ensure a project exists and reset its canvas so tests don't bleed together.
  await resetProject(request)
})

test('toolbar-created cards stack vertically with a 24px gap', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  for (let i = 0; i < 3; i++) {
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
  }

  const boxes = await page.locator('.elves-card').evaluateAll((cards) =>
    cards
      .map((card) => {
        const bounds = card.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom }
      })
      .sort((a, b) => a.top - b.top),
  )
  expect(boxes).toHaveLength(3)
  expect(Math.round(boxes[1].top - boxes[0].bottom)).toBe(24)
  expect(Math.round(boxes[2].top - boxes[1].bottom)).toBe(24)
})

test('create a prose card, type into it, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  const card = page.locator('.elves-card--prose').first()
  await expect(card).toBeVisible()

  // The button drops the new card straight into editing, so no click/dblclick
  // is needed to reach the textarea (see e2e/figures.spec.ts for the same pattern).
  await page.locator('.elves-card__editor').fill('composition was the bottleneck')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(card.getByTestId('card-text')).toHaveText('composition was the bottleneck')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  await expect(
    page.locator('.elves-card--prose').getByText('composition was the bottleneck'),
  ).toBeVisible({ timeout: 15000 })
})

test('note card is muted and shows its Note badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-note').click()
  const source = page.locator('.elves-card--note').first()
  await expect(source).toBeVisible()
  await expect(source.getByTestId('card-badge')).toHaveText('Note')
})

test('convert a text note to prose: badge flips and it enters the draft', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Make a text note and give it some words.
  await page.getByTestId('new-note').click()
  const note = page.locator('.elves-card--note').first()
  await expect(note).toBeVisible()
  const box = await note.boundingBox()
  if (!box) throw new Error('note card not in DOM')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.dblclick(cx, cy)
  await page.locator('.elves-card__editor').fill('a thought promoted into the piece')
  await page.mouse.click(50, 50) // commit

  // Select the note so its badge-row Convert action appears, then convert.
  await page.mouse.click(cx, cy)
  await page.getByTestId('convert-to-prose').click()

  // The card is now prose: badge reads Prose, and the Note face is gone.
  const prose = page.locator('.elves-card--prose').first()
  await expect(prose).toBeVisible()
  await expect(prose.getByTestId('card-badge')).toHaveText('Prose')
  await expect(page.locator('.elves-card--note')).toHaveCount(0)

  // Prose compiles into the linear draft (notes never do).
  await page.getByTestId('draft-open').click()
  await expect(page.getByTestId('draft-para')).toHaveText('a thought promoted into the piece')
})
