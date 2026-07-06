import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request) // ensure at least one project exists so the app opens a canvas
})

test('create, switch between, and rename projects from the toolbar', async ({ page }) => {
  // Unique names keep the test idempotent across repeated runs (the data dir
  // persists within a run), operating only on projects it creates itself.
  const stamp = Date.now()
  const alpha = `Alpha ${stamp}`
  const beta = `Beta ${stamp}`
  const renamed = `Alpha ${stamp} renamed`

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Create Alpha — the app switches to it — and add a card.
  page.once('dialog', (d) => d.accept(alpha))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)
  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()

  // Create Beta — the app switches to it and its canvas is empty.
  page.once('dialog', (d) => d.accept(beta))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-new').click()
  await expect(page.getByTestId('project-switcher')).toContainText(beta)
  await expect(page.locator('.elves-card--prose')).toHaveCount(0)

  // Switch back to Alpha by name — its card is still there (separate canvases).
  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: alpha }).click()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)
  await expect(page.locator('.elves-card--prose').first()).toBeVisible({ timeout: 15000 })

  // Rename Alpha — the switcher label updates. The rename also re-slugs the
  // project's id (the server moves its folder to match the new name), which
  // remounts the canvas; its card must survive the move intact.
  page.once('dialog', (d) => d.accept(renamed))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-rename').click()
  await expect(page.getByTestId('project-switcher')).toContainText(renamed)
  await expect(page.locator('.elves-card--prose').first()).toBeVisible({ timeout: 15000 })
})
