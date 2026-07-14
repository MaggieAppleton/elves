import { test, expect } from '@playwright/test'
import { createFigureCardTool } from '../mcp/tools'
import { BASE, resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

test('create a figure card, fill title + description, cycle status, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-figure').click()
  const figure = page.locator('.elves-card--figure').first()
  await expect(figure).toBeVisible()

  // The button drops the new figure straight into editing: a title input and a
  // description textarea.
  await page.getByTestId('figure-title-input').fill('Malleability spectrum')
  await page.getByTestId('figure-desc-input').fill('A rigid → malleable axis with tools placed along it')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(figure.getByTestId('figure-title')).toHaveText('Malleability spectrum')
  await expect(figure.getByTestId('figure-desc')).toHaveText('A rigid → malleable axis with tools placed along it')

  // The status chip starts at idea and cycles idea → sketched → final on click.
  const status = figure.getByTestId('figure-status')
  await expect(status).toHaveAttribute('data-status', 'idea')
  await status.click()
  await expect(status).toHaveAttribute('data-status', 'sketched')
  await status.click()
  await expect(status).toHaveAttribute('data-status', 'final')
  await status.click()
  await expect(status).toHaveAttribute('data-status', 'idea')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  const reloaded = page.locator('.elves-card--figure').first()
  await expect(reloaded.getByTestId('figure-title')).toHaveText('Malleability spectrum', { timeout: 15000 })
})

test('an MCP create_figure_card call renders a Claude-suggested figure with the agent mark', async ({ page, request }) => {
  const projectId = await resetProject(request)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-prose')).toBeEnabled()

  await createFigureCardTool(BASE, projectId, {
    title: 'Release timeline',
    description: 'the sequence of releases from 2020 to now',
    x: 200,
    y: 200,
  })

  const figure = page.locator('.elves-card--figure', { hasText: 'Release timeline' })
  await expect(figure).toBeVisible()
  // Claude-suggested figures carry the orange authorship mark: its suggestion, my call.
  await expect(figure.getByTestId('card-agent-mark')).toBeVisible()
  await expect(figure.getByTestId('figure-status')).toHaveAttribute('data-status', 'idea')
})
