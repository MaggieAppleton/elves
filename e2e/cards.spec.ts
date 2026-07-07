import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  // Ensure a project exists and reset its canvas so tests don't bleed together.
  await resetProject(request)
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
