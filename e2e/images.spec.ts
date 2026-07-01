import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('adding an image creates an image source card that renders and persists', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('image-input').setInputFiles('e2e/fixtures/handwriting.png')

  const img = page.locator('img.elves-card__image')
  await expect(img).toBeVisible({ timeout: 10000 })
  await expect(img).toHaveAttribute('src', /\/assets\/.+\.png$/)

  await page.waitForTimeout(800) // debounced save
  await page.reload()
  await expect(page.locator('img.elves-card__image')).toBeVisible({ timeout: 15000 })
})
