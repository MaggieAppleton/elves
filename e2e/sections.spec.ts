import { test, expect } from '@playwright/test'
import { createSectionTool } from '../mcp/tools'
import { BASE, resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

test('create a section header, type into it, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-section').click()
  const section = page.locator('.elves-section').first()
  await expect(section).toBeVisible()

  // The button opens the new section already in edit mode.
  await page.locator('.elves-section__editor').fill('Origins')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(section.getByTestId('section-text')).toHaveText('Origins')
  await expect(section).toHaveAttribute('data-authored-by', 'user')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  await expect(page.locator('.elves-section').getByText('Origins')).toBeVisible({ timeout: 15000 })
})

test('an MCP create_section tool call renders in the Claude accent color', async ({ page, request }) => {
  const projectId = await resetProject(request)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await createSectionTool(BASE, projectId, { text: 'The turn', x: 200, y: 200 })

  const section = page.locator('.elves-section', { hasText: 'The turn' })
  await expect(section).toBeVisible()
  await expect(section).toHaveAttribute('data-authored-by', 'claude')
})
