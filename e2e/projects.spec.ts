import { test, expect, type Page } from '@playwright/test'
import { createNoteCardTool, readSelectionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request) // ensure at least one project exists so the app opens a canvas
})

async function createPersistedProseProject(page: Page, name: string, text: string): Promise<string> {
  page.once('dialog', (dialog) => dialog.accept(name))
  await page.getByTestId('project-switcher').click()
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/projects',
  )
  const loaded = page.waitForResponse(
    (response) => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/canvas'),
  )
  await page.getByTestId('project-new').click()
  const { id } = (await (await created).json()) as { id: string }
  await loaded
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill(text)
  await page.keyboard.press('Escape')
  return id
}

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

test('project switcher follows the menu keyboard and focus model', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const trigger = page.getByTestId('project-switcher')
  const menu = page.getByRole('menu')
  const firstItem = menu.getByRole('menuitemradio').first()
  const lastItem = page.getByTestId('project-rename')

  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(firstItem).toBeFocused()

  await page.keyboard.press('End')
  await expect(lastItem).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(firstItem).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(lastItem).toBeFocused()
  await page.keyboard.press('Home')
  await expect(firstItem).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(lastItem).toBeFocused()
  await page.keyboard.press('Escape')

  await page.keyboard.press('ArrowDown')
  await expect(firstItem).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu).toHaveCount(0)
  await expect(trigger).not.toBeFocused()

  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(firstItem).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(lastItem).toBeFocused()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.keyboard.press('Enter')
  await expect(trigger).toBeFocused()
})

test('a stale project load cannot reclaim the active project lifecycle', async ({ page, request }) => {
  const stamp = Date.now()
  const alpha = `Slow Alpha ${stamp}`
  const beta = `Active Beta ${stamp}`

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Seed two persisted canvases whose snapshots each remember their selected card.
  const alphaId = await createPersistedProseProject(page, alpha, 'alpha card')
  const betaId = await createPersistedProseProject(page, beta, 'beta card')

  await expect.poll(async () => (await serverCardIds(request, alphaId)).length).toBe(1)
  await expect.poll(async () => (await serverCardIds(request, betaId)).length).toBe(1)
  const [betaCardId] = await serverCardIds(request, betaId)

  // Reload into Alpha, but hold its initial canvas GET until Beta has mounted and
  // established its own autosave + selection reporters.
  await page.evaluate((id) => localStorage.setItem('elves:lastProject', id), alphaId)
  let releaseAlpha!: () => void
  const alphaGate = new Promise<void>((resolve) => {
    releaseAlpha = resolve
  })
  let heldAlpha = false
  await page.route(
    (url) => url.pathname === `/projects/${alphaId}/canvas`,
    async (route) => {
      if (route.request().method() === 'GET' && !heldAlpha) {
        heldAlpha = true
        await alphaGate
      }
      await route.continue()
    },
  )
  const staleAlphaLoaded = page.waitForResponse(
    (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/projects/${alphaId}/canvas`,
  )
  await page.reload()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)

  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: beta }).click()
  await expect(page.locator('.elves-card--prose')).toContainText('beta card')
  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.map((shape) => shape.id))
    .toEqual([betaCardId])

  // Alpha's late response must be ignored. Before the fix it installs Alpha's
  // selection reporter under Beta's project id, replacing the selection with an
  // invalid Alpha card id (read_selection consequently returns []).
  releaseAlpha()
  await staleAlphaLoaded
  await page.waitForTimeout(250) // allow any wrongly installed reporter's 200ms debounce to fire
  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.map((shape) => shape.id))
    .toEqual([betaCardId])

  // Beta's document lifecycle still owns persistence too.
  const betaCard = page.locator('.elves-card--prose').first()
  const bounds = await betaCard.boundingBox()
  if (!bounds) throw new Error('beta card not in DOM')
  await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.locator('.elves-card__editor').fill('beta still owns autosave')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  await page.reload()
  await expect(page.locator('.elves-card--prose')).toContainText('beta still owns autosave')
})

test('a stale rejected load cannot clear the current mount pending changes', async ({ page, request }) => {
  const stamp = Date.now()
  const alpha = `Retry Alpha ${stamp}`
  const beta = `Bridge Beta ${stamp}`
  const agentText = 'arrived during the current alpha load'
  let sawAgentBroadcast!: () => void
  const agentBroadcast = new Promise<void>((resolve) => {
    sawAgentBroadcast = resolve
  })
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (payload.toString().includes(agentText)) sawAgentBroadcast()
    })
  })

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  const alphaId = await createPersistedProseProject(page, alpha, 'alpha seed')
  const betaId = await createPersistedProseProject(page, beta, 'beta seed')
  await expect.poll(async () => (await serverCardIds(request, alphaId)).length).toBe(1)
  await expect.poll(async () => (await serverCardIds(request, betaId)).length).toBe(1)

  await page.evaluate((id) => localStorage.setItem('elves:lastProject', id), alphaId)
  let rejectOldAlpha!: () => void
  const oldAlphaGate = new Promise<void>((resolve) => {
    rejectOldAlpha = resolve
  })
  let releaseCurrentAlpha!: () => void
  const currentAlphaGate = new Promise<void>((resolve) => {
    releaseCurrentAlpha = resolve
  })
  let captureCurrentAlpha!: () => void
  const currentAlphaCaptured = new Promise<void>((resolve) => {
    captureCurrentAlpha = resolve
  })
  let alphaLoads = 0
  await page.route(
    (url) => url.pathname === `/projects/${alphaId}/canvas`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      alphaLoads += 1
      if (alphaLoads === 1) {
        await oldAlphaGate
        await route.abort('failed')
        return
      }
      if (alphaLoads === 2) {
        const response = await route.fetch()
        captureCurrentAlpha()
        await currentAlphaGate
        await route.fulfill({ response })
        return
      }
      await route.continue()
    },
  )

  const loadErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') loadErrors.push(message.text())
  })
  await page.reload()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)
  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: beta }).click()
  await expect(page.locator('.elves-card--prose')).toContainText('beta seed')
  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: alpha }).click()
  await currentAlphaCaptured

  // The new Alpha request has already captured its stale snapshot. This change
  // can reach the live editor only through its buffered realtime catch-up.
  await createNoteCardTool(BASE, alphaId, { text: agentText, x: 160, y: 160 })
  await agentBroadcast
  const oldAlphaFailed = page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).pathname === `/projects/${alphaId}/canvas`,
  })
  rejectOldAlpha()
  await oldAlphaFailed
  await page.waitForTimeout(100)
  releaseCurrentAlpha()

  await expect(page.locator('.elves-card--note', { hasText: agentText })).toBeVisible({ timeout: 15000 })
  expect(loadErrors.filter((message) => message.includes('canvas load failed'))).toEqual([])
})

test('a stale review load cannot overwrite a newer visit to the same project', async ({ page, request }) => {
  const stamp = Date.now()
  const alpha = `Review Alpha ${stamp}`
  const beta = `Review Beta ${stamp}`

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  const alphaId = await createPersistedProseProject(page, alpha, 'alpha seed')
  await createPersistedProseProject(page, beta, 'beta seed')

  // Reload into Alpha and capture its initial, empty reviews response, but hold
  // it back so it can arrive after a complete Alpha → Beta → Alpha round trip.
  await page.evaluate((id) => localStorage.setItem('elves:lastProject', id), alphaId)
  let releaseOldAlpha!: () => void
  const oldAlphaGate = new Promise<void>((resolve) => {
    releaseOldAlpha = resolve
  })
  let captureOldAlpha!: () => void
  const oldAlphaCaptured = new Promise<void>((resolve) => {
    captureOldAlpha = resolve
  })
  let alphaReviewLoads = 0
  await page.route(
    (url) => url.pathname === `/projects/${alphaId}/reviews`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      alphaReviewLoads += 1
      if (alphaReviewLoads === 1) {
        const response = await route.fetch()
        captureOldAlpha()
        await oldAlphaGate
        await route.fulfill({
          response,
          headers: { ...response.headers(), 'x-elves-stale-review-load': 'true' },
        })
        return
      }
      await route.continue()
    },
  )

  await page.reload()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)
  await oldAlphaCaptured

  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: beta }).click()
  await expect(page.getByTestId('project-switcher')).toContainText(beta)

  // This review is newer than the response held above. Supplying an agent makes
  // it an already-claimed pass, so the in-app runner does not introduce timing.
  await request.post(`${BASE}/projects/${alphaId}/reviews`, {
    data: { personality: 'trimmer', agent: 'claude' },
  })

  await page.getByTestId('project-switcher').click()
  const currentAlphaLoaded = page.waitForResponse(
    (response) => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/projects/${alphaId}/reviews`,
  )
  await page.getByRole('menuitemradio', { name: alpha }).click()
  await currentAlphaLoaded
  await page.getByTestId('review-button').click()
  const currentPass = page.getByTestId('review-pass-trimmer')
  await expect(currentPass).toHaveAttribute('data-status', 'in-progress')

  // The first visit's response must not be accepted merely because Alpha is
  // current again. Before the fix it replaces the current pass with [].
  const staleAlphaLoaded = page.waitForResponse(
    (response) => response.headers()['x-elves-stale-review-load'] === 'true',
  )
  releaseOldAlpha()
  await (await staleAlphaLoaded).finished()
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  await expect(currentPass).toHaveAttribute('data-status', 'in-progress')
})

test('a stale review load cannot overwrite a newer realtime snapshot in the same visit', async ({ page, request }) => {
  const stamp = Date.now()
  const alpha = `Realtime Review Alpha ${stamp}`

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  const alphaId = await createPersistedProseProject(page, alpha, 'alpha seed')

  // Reload into Alpha and hold its initial, empty reviews response. The project
  // does not change after this point: only a newer websocket snapshot may make
  // the captured GET stale.
  await page.evaluate((id) => localStorage.setItem('elves:lastProject', id), alphaId)
  let releaseOldAlpha!: () => void
  const oldAlphaGate = new Promise<void>((resolve) => {
    releaseOldAlpha = resolve
  })
  let captureOldAlpha!: () => void
  const oldAlphaCaptured = new Promise<void>((resolve) => {
    captureOldAlpha = resolve
  })
  await page.route(
    (url) => url.pathname === `/projects/${alphaId}/reviews`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      captureOldAlpha()
      await oldAlphaGate
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'x-elves-stale-review-load': 'true' },
      })
    },
  )

  await page.reload()
  await expect(page.getByTestId('project-switcher')).toContainText(alpha)
  await oldAlphaCaptured

  // Creating an already-claimed pass broadcasts its complete review list over
  // the live websocket without starting the in-app review runner.
  await request.post(`${BASE}/projects/${alphaId}/reviews`, {
    data: { personality: 'trimmer', agent: 'claude' },
  })
  await page.getByTestId('review-button').click()
  const currentPass = page.getByTestId('review-pass-trimmer')
  await expect(currentPass).toHaveAttribute('data-status', 'in-progress')

  // Releasing the same visit's older GET used to replace the realtime state
  // with its captured empty list.
  const staleAlphaLoaded = page.waitForResponse(
    (response) => response.headers()['x-elves-stale-review-load'] === 'true',
  )
  releaseOldAlpha()
  await (await staleAlphaLoaded).finished()
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  await expect(currentPass).toHaveAttribute('data-status', 'in-progress')
})
