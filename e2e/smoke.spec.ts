import { test, expect } from '@playwright/test'

test('app boots and mounts the tldraw canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
})
