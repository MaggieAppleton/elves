import { test, expect } from '@playwright/test'
import { resetProject, serverCardIds } from './helpers'

let projectId: string
test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('adding an image creates an image note card that renders and persists', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('image-input').setInputFiles('e2e/fixtures/handwriting.png')

  const img = page.locator('img.elves-card__image')
  await expect(img).toBeVisible({ timeout: 10000 })
  await expect(img).toHaveAttribute('src', /\/projects\/.+\/assets\/.+\.png$/)

  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  await page.reload()
  await expect(page.locator('img.elves-card__image')).toBeVisible({ timeout: 15000 })
})
