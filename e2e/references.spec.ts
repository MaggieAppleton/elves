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
  await context.route('**/projects/*/unfurl', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reference: fakeRef }) }),
  )

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // The + Link flow opens an in-app modal to paste the url; Enter submits.
  await page.getByTestId('new-reference').click()
  await page.getByTestId('link-prompt-input').fill('example.com/malleable')
  await page.getByTestId('link-prompt-submit').click()

  await expect(page.getByTestId('ref-card')).toBeVisible()
  await expect(page.getByTestId('ref-title')).toHaveText('Intercepted Reference')
  // The ↗ control targets the source url.
  await expect(page.getByTestId('ref-open')).toHaveAttribute('title', /example\.com\/malleable/)
})
