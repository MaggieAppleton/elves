import { test, expect } from '@playwright/test'
import { createReferenceTool } from '../mcp/tools'
import { BASE, resetProject } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('a create_reference tool call renders a type-adaptive reference card live', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-prose')).toBeEnabled()

  // Point the unfurl at the server's own JSON endpoint (non-HTML → graceful
  // minimal reference), then let Claude's researched fields fill the face.
  await createReferenceTool(BASE, projectId, {
    url: `${BASE}/projects`,
    x: 0, y: 0,
    fields: {
      title: 'A startling glimpse of malleable software',
      refType: 'article',
      siteName: 'andymatuschak.org',
    },
  })

  const card = page.getByTestId('ref-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('ref-title')).toHaveText('A startling glimpse of malleable software')
  await expect(card).toHaveAttribute('data-reftype', 'article')
})

test('the + Link button unfurls a pasted url into a clickable reference card', async ({ page, context }) => {
  // Intercept the unfurl call so the test never reaches the network.
  const fakeRef = {
    url: 'https://example.com/malleable', refType: 'article',
    title: 'Intercepted Reference', authors: ['Andy Matuschak'], siteName: 'example.com',
    year: null, venue: null, description: 'about malleable software', faviconAssetId: null,
    thumbnailAssetId: null, doi: null, arxivId: null, fetchedBy: 'unfurl', fetchedAt: null,
  }
  let releaseUnfurl!: () => void
  const unfurlMayFinish = new Promise<void>((resolve) => { releaseUnfurl = resolve })
  await context.route('**/projects/*/unfurl', async (route) => {
    await unfurlMayFinish
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reference: fakeRef }) })
  })

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // The + Link flow opens an in-app modal to paste the url; Enter submits.
  const trigger = page.getByTestId('new-reference')
  await trigger.click()
  await page.getByTestId('link-prompt-input').fill('example.com/malleable')
  await page.getByTestId('link-prompt-submit').click()
  await expect(page.getByRole('dialog', { name: 'Add a reference' })).toBeFocused()
  releaseUnfurl()

  await expect(page.getByTestId('ref-card')).toBeVisible()
  await expect(page.getByTestId('ref-title')).toHaveText('Intercepted Reference')
  await expect(trigger).toBeFocused()
  // The ↗ control targets the source url.
  await expect(page.getByTestId('ref-open')).toHaveAttribute('title', /example\.com\/malleable/)
})

test('the link prompt traps focus and restores it to the Link button when closed', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const trigger = page.getByTestId('new-reference')
  const prompt = page.getByTestId('link-prompt')
  const input = page.getByTestId('link-prompt-input')
  const submit = page.getByTestId('link-prompt-submit')

  await trigger.click()
  await expect(input).toBeFocused()
  await input.fill('example.com')

  await page.keyboard.press('Shift+Tab')
  await expect(submit).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(input).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await expect(input).toBeFocused()
  await page.getByTestId('link-prompt-cancel').click()
  await expect(prompt).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('the busy link prompt contains cancellation, focus, and global shortcuts', async ({ page, context }) => {
  const fakeRef = {
    url: 'https://example.com/busy', refType: 'article',
    title: 'Busy Reference', authors: [], siteName: 'example.com',
    year: null, venue: null, description: null, faviconAssetId: null,
    thumbnailAssetId: null, doi: null, arxivId: null, fetchedBy: 'unfurl', fetchedAt: null,
  }
  let releaseUnfurl!: () => void
  const unfurlMayFinish = new Promise<void>((resolve) => { releaseUnfurl = resolve })
  await context.route('**/projects/*/unfurl', async (route) => {
    await unfurlMayFinish
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reference: fakeRef }) })
  })

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const trigger = page.getByTestId('new-reference')
  const prompt = page.getByTestId('link-prompt')
  const dialog = page.getByRole('dialog', { name: 'Add a reference' })
  const stage = page.locator('.elves-stage')
  await trigger.click()
  await page.getByTestId('link-prompt-input').fill('example.com/busy')
  await page.getByTestId('link-prompt-submit').click()
  await expect(dialog).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(prompt).toBeVisible()
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog).toBeFocused()

  await page.keyboard.press('Control+\\')
  await expect(stage).toHaveAttribute('data-view', 'canvas')
  await page.keyboard.press('Meta+\\')
  await expect(stage).toHaveAttribute('data-view', 'canvas')
  await page.keyboard.press('/')
  await expect(page.locator('.elves-agentbox')).toBeHidden()

  releaseUnfurl()
  await expect(prompt).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('closing the link prompt does not also close an AgentBox behind it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-prose')).toBeEnabled()

  await page.keyboard.press('/')
  const agentBox = page.locator('.elves-agentbox')
  await expect(agentBox).toBeVisible()

  const trigger = page.getByTestId('new-reference')
  await trigger.click()
  await expect(page.getByTestId('link-prompt-input')).toBeFocused()
  await page.keyboard.press('Escape')

  await expect(page.getByTestId('link-prompt')).toBeHidden()
  await expect(agentBox).toBeVisible()
  await expect(trigger).toBeFocused()
})
