import { test, expect } from '@playwright/test'
import { createNoteCardTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

// Deterministic reproduction of the "change-set dropped before the canvas
// finishes loading" race (issue #9). The flaky suite hits it by accident when
// full-suite load makes loadCanvas resolve late; here we force it by holding the
// initial canvas load open, so a change-set is GUARANTEED to arrive while the
// store is still loading. Before the fix the change-set is silently dropped and
// the card never renders; after the fix it is buffered and reconciled on load.

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('a change-set that arrives before the canvas finishes loading still renders', async ({ page, request }) => {
  // Seed the canvas once. A brand-new project intentionally rejects agent
  // changes until its first document exists; this race concerns an existing
  // document reloading while a persisted change arrives.
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill('persisted seed')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)

  // Hold ONLY the reload's first canvas GET open for a beat so
  // the MCP create below lands squarely inside the load window. The post-fix
  // reconcile re-fetches the canvas, so let every later GET through untouched or
  // the catch-up would be delayed too. WebSocket broadcasts aren't HTTP, so the
  // change-set still arrives promptly during the held window.
  let firstCanvasGetHeld = false
  await page.route(
    (url) => url.pathname.endsWith('/canvas'),
    async (route) => {
      if (route.request().method() === 'GET' && !firstCanvasGetHeld) {
        firstCanvasGetHeld = true
        const response = await route.fetch()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.fulfill({ response })
        return
      }
      await route.continue()
    },
  )

  await page.reload()
  // The canvas element mounts (and is visible) well before its document loads —
  // which is exactly the window the bug lives in.
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Claude creates a note through the MCP while the store is still loading.
  await createNoteCardTool(BASE, projectId, { text: 'created mid-load', x: 120, y: 120 })

  // It must still render once the canvas catches up — exactly once, no duplicate.
  const card = page.locator('.elves-card--note', { hasText: 'created mid-load' })
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.elves-card--note')).toHaveCount(1)
})
